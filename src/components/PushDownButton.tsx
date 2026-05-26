import { useState, useRef, type ReactNode, type CSSProperties } from 'react';
import { oklchShadow, oklchHighlight, deriveCardSurfaces } from '../utils/colorUtils';
import { SURFACE } from '../utils/constants';

interface PushDownButtonProps {
  children: ReactNode;
  onTap?: () => void;
  color: string;
  borderRadius?: number;
  height?: number;
  bottomBorderWidth?: number;
  bottomBorderColor?: string;
  // Override the top face's inner-stroke (border) colour. Default = the
  // OKLCh-highlight derived from `color`. Useful for "outlined" looks
  // where a visible dark border is wanted around a light fill.
  innerStrokeColor?: string;
  innerStrokeWidth?: number;
  // When set, holding the button for `delayMs` starts firing `onTap`
  // every `intervalMs`. If `maxIntervalMs` + `rampMs` are also set, the
  // interval interpolates linearly from `intervalMs` down to
  // `maxIntervalMs` (faster) over `rampMs` of continuous hold. Normal
  // taps (release before `delayMs`) still commit once via the click
  // event. Release / cancel stops the repeat.
  repeatHold?: { delayMs: number; intervalMs: number; maxIntervalMs?: number; rampMs?: number };
  style?: CSSProperties;
}

export function PushDownButton({
  children,
  onTap,
  color,
  borderRadius = 21,
  height = 64,
  bottomBorderWidth = 6.5,
  bottomBorderColor,
  innerStrokeColor,
  innerStrokeWidth = 2.5,
  repeatHold,
  style,
}: PushDownButtonProps) {
  const [pressed, setPressed] = useState(false);
  // Same OKLCh-derived recipe as cards: top face + bottom face + halo + inner
  // stroke all flow from one base. The optional `bottomBorderColor` /
  // `innerStrokeColor` overrides are preserved for callers that hand-pick
  // the lower-layer or stroke colour.
  const surfaces = deriveCardSurfaces(color);
  const bottomColor = bottomBorderColor ?? surfaces.bottom;
  const haloColor = bottomBorderColor ? `${bottomColor}40` : surfaces.halo;
  const strokeColor = innerStrokeColor ?? surfaces.innerStroke;
  const faceHeight = height - bottomBorderWidth;

  // Press visual is tied to the live pointer state; the commit is tied to
  // the browser's `click` event. Splitting these two responsibilities
  // matters in scroll containers (the chip row, for one): capturing the
  // pointer to detect release fights the browser's scroll arbitration
  // mid-touch, so we don't capture — instead, `click` does the right
  // thing automatically (fires only when pointerdown + pointerup land on
  // the same element, i.e. a clean tap; doesn't fire if the user dragged
  // off or the gesture became a scroll). Pointer-leave / pointer-cancel
  // release the visual without committing.
  // Repeat-hold timers + flag. The flag tells the click handler whether a
  // long-press already fired onTap (so we don't double-commit on release).
  const repeatTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const repeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const didRepeatRef = useRef(false);

  const stopRepeat = () => {
    if (repeatTimerRef.current) { clearTimeout(repeatTimerRef.current); repeatTimerRef.current = null; }
    if (repeatIntervalRef.current) { clearInterval(repeatIntervalRef.current); repeatIntervalRef.current = null; }
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    if (!onTap) return;
    setPressed(true);
    if (!repeatHold) return;
    // Repeat-hold buttons consume the gesture: stop propagation so the
    // parent SwipeableActionCell (segment swipe) and SnappingSheet
    // (vertical drag) don't see the press, and capture the pointer so
    // subsequent moves/up stay on us regardless of finger drift.
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    didRepeatRef.current = false;
    repeatTimerRef.current = setTimeout(() => {
      repeatTimerRef.current = null;
      didRepeatRef.current = true;
      onTap();
      // If ramp is configured, schedule recursively with an interpolated
      // delay; otherwise use a fixed-interval setInterval. tStart anchors
      // the ramp to "first auto-fire" so the slow-end is felt right away
      // and the user has to keep holding to reach the fast end.
      const { intervalMs, maxIntervalMs, rampMs } = repeatHold;
      if (maxIntervalMs != null && rampMs != null && rampMs > 0) {
        const tStart = performance.now();
        const tick = () => {
          onTap();
          const elapsed = performance.now() - tStart;
          const t = Math.min(1, elapsed / rampMs);
          const cur = intervalMs + (maxIntervalMs - intervalMs) * t;
          repeatTimerRef.current = setTimeout(tick, cur);
        };
        repeatTimerRef.current = setTimeout(tick, intervalMs);
      } else {
        repeatIntervalRef.current = setInterval(() => onTap(), intervalMs);
      }
    }, repeatHold.delayMs);
  };

  const releaseVisual = () => {
    setPressed(false);
    stopRepeat();
  };

  const handleClick = () => {
    // Long-press already fired onTap (and possibly many more via interval).
    // Don't double-commit on the release-click; consume the flag and bail.
    if (didRepeatRef.current) {
      didRepeatRef.current = false;
      return;
    }
    onTap?.();
  };

  return (
    <div
      onPointerDown={handlePointerDown}
      onPointerUp={releaseVisual}
      onPointerLeave={releaseVisual}
      onPointerCancel={releaseVisual}
      onClick={handleClick}
      style={{
        height,
        position: 'relative',
        // Establish a new block formatting context. Without this, the top
        // face's `marginTop` (the press animation) collapses with this
        // container's own top margin — when `pressed` flips `marginTop`
        // from 0 to `bottomBorderWidth`, that value leaks OUT of the
        // container as its own collapsed top margin, shifting the WHOLE
        // button down instead of moving the top face within it. Block-
        // level callers (full-width buttons) hit this; flex-item callers
        // (chips in a flex row) don't, since flex items don't margin-
        // collapse. `flow-root` solves both with one rule.
        display: 'flow-root',
        cursor: onTap ? 'pointer' : 'default',
        userSelect: 'none',
        // Remove the iOS/Android default blue/grey tap highlight rectangle
        // and the 300ms tap-delay double-tap-zoom heuristic. Without these,
        // a PushDownButton inside an arbitrary parent (chip row, sheet,
        // plain page) looks and feels identical — its press behaviour
        // doesn't depend on whether an ancestor happens to have set the
        // same rules.
        WebkitTapHighlightColor: 'transparent',
        // Repeat-hold buttons need 'none' so the browser doesn't claim
        // the touch for scrolling — without this the parent scroll
        // container would cancel the pointer mid-hold and the repeat
        // would stop unexpectedly. Normal buttons stay 'manipulation'.
        touchAction: repeatHold ? 'none' : 'manipulation',
        ...style,
      }}
    >
      {/* Bottom layer — the lifted shadow face. Anchored at
          `top: bottomBorderWidth, bottom: 0` so it sits below where the
          top face rests. When the top face slides down on press, the area
          ABOVE the bottom layer's top edge is transparent — whatever the
          button sits on shows through. (Filling that area with `bottomColor`
          looks wrong on chips: the derived bottom shade reads as "almost
          but not quite" the surrounding bg.) Halo boxShadow on this layer's
          top edge so the outer ring tracks the lifted-face position. */}
      <div style={{
        position: 'absolute',
        top: bottomBorderWidth,
        left: 0,
        right: 0,
        bottom: 0,
        borderRadius,
        backgroundColor: bottomColor,
        boxShadow: `0 0 0 3.5px ${haloColor}`,
      }} />
      {/* Top layer — moves DOWN on press. Relative (not absolute) so the
          container derives its intrinsic content width from this layer —
          auto-sized chips need that. marginTop animates from 0 to
          `bottomBorderWidth`, sliding the top face down to align with the
          bottom face; the visible peek collapses to 0. Container CSS height
          is unchanged; the painted area shifts down within it. */}
      <div style={{
        position: 'relative',
        height: faceHeight,
        marginTop: pressed ? bottomBorderWidth : 0,
        borderRadius,
        // While pressed (top face fully down on the bottom face, peek =
        // 0), OKLCh-lighten both the fill and the inner stroke so the
        // button reads as briefly "lit up" at the bottom of its press
        // animation — same recipe as the card stack uses for derived
        // highlights, applied a beat brighter on press.
        backgroundColor: pressed ? oklchHighlight(surfaces.top, 0.05) : surfaces.top,
        border: `${innerStrokeWidth}px solid ${pressed ? oklchHighlight(strokeColor, 0.05) : strokeColor}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        transition: 'margin-top 0.1s ease, background-color 0.1s ease, border-color 0.1s ease',
      }}>
        {children}
      </div>
    </div>
  );
}

interface InsetTextFieldProps {
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  color?: string;
  borderRadius?: number;
  depth?: number;
  style?: CSSProperties;
  inputStyle?: CSSProperties;
}

export function InsetTextField({
  value,
  onChange,
  onBlur,
  placeholder,
  color = '#F8F8F9',
  borderRadius = 14,
  depth = 2.5,
  style,
  inputStyle,
}: InsetTextFieldProps) {
  const backColor = oklchShadow(color);
  const innerStrokeColor = oklchShadow(color, 0.06);

  return (
    <div style={{ position: 'relative', ...style }}>
      {/* Back face */}
      <div style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: depth,
        borderRadius,
        backgroundColor: backColor,
      }} />
      {/* Front face */}
      <div style={{
        position: 'relative',
        marginTop: depth,
        borderRadius,
        backgroundColor: color,
        border: `2.5px solid ${innerStrokeColor}`,
      }}>
        <input
          type="text"
          value={value}
          onChange={e => onChange(e.target.value)}
          onBlur={onBlur}
          placeholder={placeholder}
          style={{
            width: '100%',
            border: 'none',
            outline: 'none',
            background: 'transparent',
            padding: '10px 12px',
            fontSize: 16,
            fontWeight: 600,
            fontFamily: 'inherit',
            color: '#1E1E2C',
            ...inputStyle,
          }}
        />
      </div>
    </div>
  );
}

interface SunkenPushDownButtonProps {
  children: ReactNode;
  color: string;
  borderRadius?: number;
  depth?: number;
  style?: CSSProperties;
}

export function SunkenPushDownButton({
  children,
  color,
  borderRadius = 12,
  depth = 6,
  style,
}: SunkenPushDownButtonProps) {
  // Same OKLCh recipe as the 3D cards: a single base drives the front
  // fill, the deeper back layer, and the inner stroke. Keeps the action
  // buttons visually consistent with the segment / block cards they sit
  // behind.
  const surfaces = deriveCardSurfaces(color);

  return (
    <div style={{
      position: 'relative',
      height: '100%',
      width: '100%',
      ...style,
    }}>
      {/* Back face — outer 3px boxShadow ring acts as a stroke just
          outside the button silhouette, slightly lighter than the sheet
          bg (SURFACE) so the button reads as cut into a separate
          surface from the row behind it. */}
      <div style={{
        position: 'absolute',
        inset: 0,
        borderRadius,
        backgroundColor: surfaces.bottom,
        boxShadow: `0 0 0 3px ${oklchHighlight(SURFACE, 0.04)}`,
      }} />
      {/* Front face — 3px inner stroke on top + sides only; the bottom
          edge is left strokeless so the front face blends straight into
          the back face's bottom curve. */}
      <div style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        top: depth,
        borderRadius,
        backgroundColor: surfaces.top,
        borderTop: `3px solid ${surfaces.innerStroke}`,
        borderLeft: `3px solid ${surfaces.innerStroke}`,
        borderRight: `3px solid ${surfaces.innerStroke}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}>
        {children}
      </div>
    </div>
  );
}
