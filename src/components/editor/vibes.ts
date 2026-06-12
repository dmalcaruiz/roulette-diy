import { SEGMENT_COLORS } from '../../utils/constants';

// A slice colour "vibe" — tapping one recolours every slice by cycling its
// `palette`. The first 5 colours show in the card preview.
export interface SliceVibe {
  key: string;
  palette: string[];
}

export const SLICE_VIBES: SliceVibe[] = [
  { key: 'classic',   palette: SEGMENT_COLORS },
  { key: 'candy',     palette: ['#FF3D77', '#FF8A3D', '#FFD23D', '#5BD96A', '#3DD6D0', '#4DA3FF', '#9B6DFF', '#FF6DC4'] },
  { key: 'sunset',    palette: ['#FF4D6D', '#FF7A45', '#FFB23D', '#FFD93D', '#FF5DA8', '#C44DFF', '#7A4DFF', '#FF914D'] },
  { key: 'ocean',     palette: ['#3DD6D0', '#3DA5FF', '#5B7BFF', '#6D5BFF', '#3DE0A8', '#4DD6FF', '#5BE0C4', '#7A6DFF'] },
  { key: 'eerie',     palette: ['#0B3D2E', '#14694A', '#1E8F63', '#3FA66B', '#5FB37C', '#7CC893', '#2E8B57', '#145A32'] },
  { key: 'spooky',    palette: ['#FF7518', '#8B4FBF', '#39D353', '#FFB627', '#6A0DAD', '#FF6B35', '#B5179E', '#2D1B4E'] },
  { key: 'horror',    palette: ['#8B0000', '#B0000A', '#6B0000', '#A30000', '#D32F2F', '#4A0000', '#7A0000', '#5C0000'] },
  { key: 'pastel',    palette: ['#FFB3C6', '#FFC8DD', '#FCB5D9', '#E0BBE4', '#D9B6FF', '#B5EAD7', '#C7CEEA', '#FFDAC1'] },
  { key: 'vaporwave', palette: ['#FF6AD5', '#C774E8', '#AD8CFF', '#94D0FF', '#01CDFE', '#FF71CE', '#B967FF', '#05FFA1'] },
];

// The colours shown on a vibe card (the "colour cuts").
export function vibePreview(vibe: SliceVibe): string[] {
  return vibe.palette.slice(0, 5);
}

// True when every slice colour is a member of this vibe's palette — drives the
// active-card highlight (a fresh wheel using SEGMENT_COLORS reads as `classic`).
export function isVibeActive(vibe: SliceVibe, sliceColors: string[]): boolean {
  if (sliceColors.length === 0) return false;
  const pal = vibe.palette.map(c => c.toLowerCase());
  return sliceColors.every(c => pal.includes(c.toLowerCase()));
}

// The new colour for each slice index, cycling the vibe's palette.
export function recolorWithVibe(vibe: SliceVibe, count: number): string[] {
  return Array.from({ length: count }, (_, i) => vibe.palette[i % vibe.palette.length]);
}

// localStorage key for the user's drag-reordered vibe order (owned by VibeRow).
export const VIBE_ORDER_KEY = 'wheelVibeOrder';

// The vibe currently FIRST in the user's saved (reorderable) order, defaulting to
// the first built-in vibe. The fallback when a wheel matches no vibe.
export function firstOrderedVibe(): SliceVibe {
  try {
    const raw = localStorage.getItem(VIBE_ORDER_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        for (const k of arr) {
          const v = SLICE_VIBES.find(sv => sv.key === k);
          if (v) return v;
        }
      }
    }
  } catch { /* ignore */ }
  return SLICE_VIBES[0];
}

// localStorage key remembering the vibe the user last applied — the "selected"
// one. A freshly-added wheel inherits it, so new wheels match the latest pick.
const SELECTED_VIBE_KEY = 'wheelSelectedVibe';

// Record the vibe the user just applied as the selected one.
export function rememberSelectedVibe(key: string): void {
  try { localStorage.setItem(SELECTED_VIBE_KEY, key); } catch { /* ignore */ }
}

// The currently-selected vibe (the last one applied), defaulting to the first
// built-in vibe when nothing's been picked yet. New wheels are coloured with it.
export function selectedVibe(): SliceVibe {
  try {
    const key = localStorage.getItem(SELECTED_VIBE_KEY);
    if (key) {
      const v = SLICE_VIBES.find(sv => sv.key === key);
      if (v) return v;
    }
  } catch { /* ignore */ }
  return firstOrderedVibe();
}

// The vibe currently in effect for these slice colours — the one whose palette
// they all belong to, DEFAULTING to the first vibe. New slices pull their colour
// from this palette so additions keep whatever vibe is selected.
export function activeVibe(sliceColors: string[]): SliceVibe {
  return SLICE_VIBES.find(v => isVibeActive(v, sliceColors)) ?? SLICE_VIBES[0];
}

// Like activeVibe, but returns null when NO vibe genuinely matches (instead of
// defaulting to the first). Lets a caller remember a wheel's vibe only when it
// truly has one — a custom palette won't overwrite the remembered selection.
export function matchedVibe(sliceColors: string[]): SliceVibe | null {
  return SLICE_VIBES.find(v => isVibeActive(v, sliceColors)) ?? null;
}
