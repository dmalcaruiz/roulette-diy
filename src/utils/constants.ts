// Design tokens — dark theme. The previous light values are kept inline as
// comments so the migration history is visible at a glance.
export const PRIMARY = '#38BDF8';
export const PRIMARY_DARK = '#0EA5E9';
// Page background — what shows behind every screen.
export const BG = '#1b1b22';
// Card / sheet surface — slightly lifted from BG so cards read as raised.
export const SURFACE = '#26262e';        // was '#FFFFFF'
// Subtly elevated surface for inputs / chips / muted cells.
export const SURFACE_ELEVATED = '#2e2e36'; // was '#F4F4F5'
// Foreground (text/icon) on dark surfaces.
export const ON_SURFACE = '#F4F4F5';     // was '#1E1E2C'
// Border / inner-stroke on dark surfaces.
export const BORDER = '#3a3a42';         // was '#D4D4D8'
// Subtle inner stroke (e.g. card top-face inner border).
export const INNER_STROKE = '#3a3a42';   // was '#E4E4E7'
export const RADIUS = 18;

// Block type colors
export const ROULETTE_COLOR = '#38BDF8';
export const LIST_COLOR = '#88d515';
export const EXPERIENCE_COLOR = '#c827d4';

// Segment palette. The first 8 are the new-wheel default (see newRouletteBlock)
// AND the first / 'classic' vibe, so a fresh wheel reads as that vibe and its
// card shows selected — keep the yellow here (#ffd500) equal to the new wheel's.
export const SEGMENT_COLORS = [
  '#fb2d29', '#fb9000', '#ffd500', '#88d515', '#00c485',
  '#00ace7', '#303dcb', '#c827d4', '#fd41a4', '#322d2a',
];
