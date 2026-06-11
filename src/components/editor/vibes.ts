import { SEGMENT_COLORS } from '../../utils/constants';

// A slice colour "vibe" — tapping one recolours every slice by cycling its
// `palette`. `classic` mirrors the SEGMENT_COLORS the editor assigns to new
// slices (the default look); the rest are brighter Spinly-style sets. `cols`
// is the 4-stripe swatch shown on the picker chip.
export interface SliceVibe {
  key: string;
  cols: string[];
  palette: string[];
}

export const SLICE_VIBES: SliceVibe[] = [
  { key: 'classic', cols: [SEGMENT_COLORS[0], SEGMENT_COLORS[2], SEGMENT_COLORS[3], SEGMENT_COLORS[5]], palette: SEGMENT_COLORS },
  { key: 'candy',   cols: ['#FF3D77', '#FFD23D', '#3DD6D0', '#9B6DFF'], palette: ['#FF3D77', '#FF8A3D', '#FFD23D', '#5BD96A', '#3DD6D0', '#4DA3FF', '#9B6DFF', '#FF6DC4'] },
  { key: 'sunset',  cols: ['#FF4D6D', '#FF914D', '#FFD93D', '#C44DFF'], palette: ['#FF4D6D', '#FF7A45', '#FFB23D', '#FFD93D', '#FF5DA8', '#C44DFF', '#7A4DFF', '#FF914D'] },
  { key: 'ocean',   cols: ['#3DD6D0', '#3DA5FF', '#6D5BFF', '#3DE0A8'], palette: ['#3DD6D0', '#3DA5FF', '#5B7BFF', '#6D5BFF', '#3DE0A8', '#4DD6FF', '#5BE0C4', '#7A6DFF'] },
];

// True when every slice colour is a member of this vibe's palette — drives the
// active-chip highlight (a fresh wheel using SEGMENT_COLORS reads as `classic`).
export function isVibeActive(vibe: SliceVibe, sliceColors: string[]): boolean {
  if (sliceColors.length === 0) return false;
  const pal = vibe.palette.map(c => c.toLowerCase());
  return sliceColors.every(c => pal.includes(c.toLowerCase()));
}

// The new colour for each slice index, cycling the vibe's palette.
export function recolorWithVibe(vibe: SliceVibe, count: number): string[] {
  return Array.from({ length: count }, (_, i) => vibe.palette[i % vibe.palette.length]);
}
