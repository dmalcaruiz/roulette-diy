import { useState, useRef, type ReactNode, type CSSProperties } from 'react';
import { oklchShadow, deriveCardSurfaces } from '../utils/colorUtils';

interface PushDownButtonProps {
  children: ReactNode;
  onTap?: () => void;
  color: string;
  borderRadius?: number;
  height?: number;
  bottomBorderWidth?: number;
  bottomBorderColor?: string;
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
  style,
}: PushDownButtonProps) {
  const [pressed, setPressed] = useState(false);
  // Same OKLCh-derived recipe as cards: top face + bottom face + halo + inner
  // stroke all flow from one base. The optional `bottomBorderColor` override
  // is preserved for callers that hand-pick the lower-layer colour.
  const surfaces = deriveCardSurfaces(color);
  const bottomColor = bottomBorderColor ?? surfaces.bottom;
  const haloColor = bottomBorderColor ? `${bottomColor}40` : surfaces.halo;
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
  const handlePointerDown = () => { if (onTap) setPressed(true); };
  const releaseVisual = () => setPressed(false);
  const handleClick = () => { onTap?.(); };

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
        touchAction: 'manipulation',
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
        backgroundColor: surfaces.top,
        border: `2.5px solid ${surfaces.innerStroke}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        transition: 'margin-top 0.1s ease',
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
      {/* Back face */}
      <div style={{
        position: 'absolute',
        inset: 0,
        borderRadius,
        backgroundColor: surfaces.bottom,
      }} />
      {/* Front face */}
      <div style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        top: depth,
        borderRadius,
        backgroundColor: surfaces.top,
        border: `2.5px solid ${surfaces.innerStroke}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}>
        {children}
      </div>
    </div>
  );
}
