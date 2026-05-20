import { useState, useRef, useEffect, type ReactNode, type CSSProperties } from 'react';
import { SunkenPushDownButton } from './PushDownButton';

// Module-level pointer to the currently-active swipe cell — its close() ref.
// Only one cell is allowed to be drag/snapped at a time across the whole
// app. When a new cell starts dragging (pointer crosses the activation
// threshold), it calls the previous cell's close() and takes over the slot.
// Cells clear the slot on transitionend when they return to rest, and on
// unmount.
let activeCloseRef: { current: () => void } | null = null;

export interface SwipeAction {
  color: string;
  icon: ReactNode;
  iconColor?: string;
  onTap?: () => void;
  expandOnFullSwipe?: boolean;
}

interface SwipeableActionCellProps {
  children: ReactNode;
  leadingActions?: SwipeAction[];
  trailingActions?: SwipeAction[];
  fullSwipeThreshold?: number;
  style?: CSSProperties;
  // For 3D-style cards whose child has paddingBottom equal to the bottom-
  // face peek, set this to that peek (e.g. 6.5). The action buttons then
  // span only the top-face region and tuck against the bottom of the cell,
  // visually nesting in the same band as the bottom-face shadow layer.
  bottomPeek?: number;
  // When true, all pointer interactions are no-ops and any in-flight swipe
  // animates back to rest. Used by callers that have a competing gesture
  // (e.g. drag-to-reorder) to suppress the swipe path while the other
  // gesture is active.
  disabled?: boolean;
  // Called with the current horizontal offset on every change (including
  // during drag, on snap, and on cancel-back). Used by callers that need
  // to translate an element outside the cell's overflow:hidden box in sync
  // with the card — e.g. the row's halo / drop shadow which sit on the
  // outer row wrapper to escape the clip.
  onOffsetChange?: (offset: number, dragging: boolean) => void;
  // Halo node rendered as a sibling of the card's translate wrapper —
  // sits ABOVE the action buttons (so it visually covers them when the
  // card swipes aside) but BELOW the card's top face (which is inside
  // the translate wrapper and paints last). The cell's overflow:hidden
  // is applied only to the inner translate wrapper, so the halo can
  // extend outside the cell on its sides / below without being clipped.
  halo?: ReactNode;
}

export default function SwipeableActionCell({
  children,
  leadingActions = [],
  trailingActions = [],
  fullSwipeThreshold = 0.55,
  style,
  bottomPeek = 0,
  disabled = false,
  onOffsetChange,
  halo,
}: SwipeableActionCellProps) {
  const [offset, setOffset] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  // Which side's actions are currently revealed. Set when a drag enters
  // either direction; *not* cleared when offset returns to 0 — instead it
  // clears on transitionend, so the action buttons stay mounted for the
  // full duration of the cancel-back-to-rest slide. Without this, the
  // buttons would unmount the moment React's `offset` state hits 0 and
  // the user would see an empty void revealed behind a still-animating
  // card.
  const [revealedSide, setRevealedSide] = useState<'leading' | 'trailing' | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const startXRef = useRef(0);
  const startYRef = useRef(0);
  const startOffsetRef = useRef(0);
  const isPendingRef = useRef(false);
  const isDraggingRef = useRef(false);
  const didSwipeRef = useRef(false);

  // Stable ref-as-identity so this cell can register itself in the
  // module-level `activeCloseRef` slot. The function it holds is a thin
  // closure over setOffset (which React guarantees is stable).
  const closeRef = useRef<() => void>(() => setOffset(0));
  // On unmount, vacate the slot if we own it — otherwise an unmounted cell
  // would hold the slot and the next cell would call a stale close() on a
  // dead React tree.
  useEffect(() => {
    return () => {
      if (activeCloseRef === closeRef) activeCloseRef = null;
    };
  }, []);

  // Mirror offset to the host whenever it changes. Used so outer-row halos
  // / drop shadows (which sit on a wrapper outside this cell's overflow-
  // hidden box) can be translated in lockstep with the card.
  const onOffsetChangeRef = useRef(onOffsetChange);
  onOffsetChangeRef.current = onOffsetChange;
  useEffect(() => {
    onOffsetChangeRef.current?.(offset, isDragging);
  }, [offset, isDragging]);

  // Disabled mid-swipe — collapse back to rest with the standard animation.
  useEffect(() => {
    if (!disabled) return;
    isPendingRef.current = false;
    if (isDraggingRef.current) {
      isDraggingRef.current = false;
      setIsDragging(false);
    }
    setOffset(0);
  }, [disabled]);

  const handlePointerDown = (e: React.PointerEvent) => {
    if (disabled) return;
    isPendingRef.current = true;
    isDraggingRef.current = false;
    didSwipeRef.current = false;
    startXRef.current = e.clientX;
    startYRef.current = e.clientY;
    startOffsetRef.current = offset;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (disabled) return;
    if (!isPendingRef.current && !isDraggingRef.current) return;

    const dx = e.clientX - startXRef.current;
    const dy = e.clientY - startYRef.current;

    if (isPendingRef.current) {
      if (Math.abs(dx) > 10) {
        // Horizontal movement — start swiping
        isPendingRef.current = false;
        isDraggingRef.current = true;
        setIsDragging(true);
        didSwipeRef.current = true;
        // Take over the single global swipe slot: if another cell is
        // currently open, kick its close() so it animates back to rest.
        // Identity-compare on the ref object itself so re-grabbing the
        // already-open cell is a no-op.
        if (activeCloseRef && activeCloseRef !== closeRef) {
          activeCloseRef.current();
        }
        activeCloseRef = closeRef;
        // Fall through to process offset
      } else if (Math.abs(dy) > 10) {
        // Vertical movement — not a swipe, cancel
        isPendingRef.current = false;
        return;
      } else {
        return; // Still pending direction
      }
    }

    if (!isDraggingRef.current) return;

    let newOffset = startOffsetRef.current + dx;
    // Cap travel at the snap position on each side — the card cannot be
    // dragged past where it would rest after release, regardless of
    // whether the gesture started from rest or from an existing snap.
    // The snap is the hard end-of-track; no rubber-band, no full-swipe
    // overshoot. (`expandOnFullSwipe` actions still fire via tap.)
    const trailingSnap = trailingActions.length > 0 ? trailingActions.length * 60 + 12 : 0;
    const leadingSnap = leadingActions.length > 0 ? leadingActions.length * 60 + 12 : 0;
    newOffset = Math.max(-trailingSnap, Math.min(leadingSnap, newOffset));
    setOffset(newOffset);
    // Track the revealed side so the action buttons stay mounted during a
    // cancel-back-to-rest animation. Don't reset at exactly 0 mid-drag —
    // a fast drag-through to the opposite side would otherwise blink.
    if (newOffset > 0) setRevealedSide('leading');
    else if (newOffset < 0) setRevealedSide('trailing');
  };

  const handlePointerUp = () => {
    isPendingRef.current = false;

    if (!isDraggingRef.current) return;
    isDraggingRef.current = false;
    setIsDragging(false);

    const absOffset = Math.abs(offset);
    const containerWidth = containerRef.current?.offsetWidth ?? 300;
    const threshold = containerWidth * fullSwipeThreshold;

    const actions = offset > 0 ? leadingActions : trailingActions;
    const snapPosition = actions.length * 60 + 12;

    if (absOffset >= threshold) {
      // Full swipe — trigger action
      const expanding = actions.find(a => a.expandOnFullSwipe) ?? actions[0];
      expanding?.onTap?.();
      setOffset(0);
    } else if (absOffset >= snapPosition * 0.5) {
      // Snap open
      setOffset(offset > 0 ? snapPosition : -snapPosition);
    } else {
      setOffset(0);
    }
  };

  const actions = revealedSide === 'leading'
    ? leadingActions
    : revealedSide === 'trailing'
      ? trailingActions
      : [];
  const isLeading = revealedSide === 'leading';

  return (
    <div
      ref={containerRef}
      style={{
        position: 'relative',
        // No overflow clip here. The clip lives on the inner translate
        // wrapper below, so action buttons + halo can sit between the
        // outer cell and the clipped translate layer — letting the halo
        // sit above the buttons (z-wise) but below the card top face,
        // and extend outside the cell on sides / below without clipping.
        touchAction: 'pan-y',
        ...style,
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onClickCapture={(e) => {
        if (didSwipeRef.current) {
          e.stopPropagation();
          e.preventDefault();
          didSwipeRef.current = false;
        }
      }}
    >
      {/* Action buttons behind. Mounted whenever a side is revealed — and
          stays mounted across the cancel-back-to-rest animation, since
          revealedSide is only cleared on the main content's transitionend
          (see below) rather than the moment offset hits 0. */}
      {revealedSide !== null && (
        <div style={{
          position: 'absolute',
          // Top inset = peek + 2; bottom: 2. The peek is the vertical
          // separation between the card's top face and bottom face — the
          // sliver of the lower layer that's visible below the top one.
          // Using it for the top inset keeps the buttons visually
          // aligned with the bottom layer (where the card "sits") rather
          // than with the very top of the cell, so the button row
          // matches the card's bottom-rest position with a tiny 2px air
          // gap above and below.
          // right:3 nudges the trailing-side buttons 3px in from the
          // cell's right edge.
          top: bottomPeek + 2,
          left: 0,
          right: 3,
          bottom: 2,
          display: 'flex',
          alignItems: 'stretch',
          justifyContent: isLeading ? 'flex-start' : 'flex-end',
          padding: '4px 8px',
          gap: 8,
        }}>
          {actions.map((action, i) => (
            <div
              key={i}
              onClick={(e) => {
                e.stopPropagation();
                action.onTap?.();
                setOffset(0);
              }}
              style={{ width: 52, cursor: 'pointer' }}
            >
              <SunkenPushDownButton color={action.color}>
                <div style={{ color: action.iconColor ?? 'rgba(255,255,255,0.85)', display: 'flex' }}>
                  {action.icon}
                </div>
              </SunkenPushDownButton>
            </div>
          ))}
        </div>
      )}
      {/* Halo — sits between the action buttons (rendered above) and
          the card (rendered below in the clipped wrapper). Z-order is
          DOM-order: buttons < halo < card. The host passes the actual
          halo node so its colour / size / ref / transform-sync stay in
          BlockList's / WheelEditor's hands. */}
      {halo}
      {/* No overflow:hidden here — the card's top + bottom faces (and the
          halo) all slide past the cell bounds and clip only at the page
          edge (body sets overflow:hidden). The scroll container of the
          host screen handles the horizontal-axis clip so a swipe-right
          can't trigger a scrollbar.

          pointer-events:none on the wrapper so it doesn't catch hits at
          its full-width bounds — only the inner translated div (with
          pointer-events:auto) catches, and only at its translated visual
          position. Clicks outside that visual position (e.g. where the
          card has slid AWAY and the action buttons are revealed) fall
          through to the absolute action buttons underneath. */}
      <div style={{ position: 'relative', pointerEvents: 'none' }}>
        <div
          style={{
            pointerEvents: 'auto',
            transform: `translateX(${offset}px)`,
            // Keep `transform` in the transition list always — only the
            // duration toggles. If the property list itself swapped between
            // 'none' and 'transform 0.15s' on release, the same-commit value
            // change to offset:0 would land before the new transition list
            // activated, and the cell would snap to rest instead of glide.
            transition: isDragging
              ? 'transform 0s ease-out'
              : 'transform 0.18s cubic-bezier(0.32, 0.72, 0, 1)',
          }}
          onTransitionEnd={(e) => {
            // Only clear the revealed side once the slide-back has fully
            // landed at rest. Until then the buttons stay mounted underneath
            // so the user sees them through the partially-translated card
            // rather than an empty void.
            if (e.propertyName === 'transform' && offset === 0) {
              setRevealedSide(null);
              // We've landed at rest — vacate the global swipe slot if we
              // were holding it. A new cell can then claim it without
              // calling close() on us again.
              if (activeCloseRef === closeRef) activeCloseRef = null;
            }
          }}
          onClick={Math.abs(offset) > 10 ? () => setOffset(0) : undefined}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
