import { useState, useRef, useEffect, type ReactNode, type CSSProperties } from 'react';
import { SunkenPushDownButton } from './PushDownButton';

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
}

export default function SwipeableActionCell({
  children,
  leadingActions = [],
  trailingActions = [],
  fullSwipeThreshold = 0.55,
  style,
  bottomPeek = 0,
  disabled = false,
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
    // Forbid over-drag past a side snap. When the gesture started from a
    // snapped state (offset already at a non-zero rest position), further
    // motion in the same direction is clamped to the start — the cell
    // can drag back toward rest (and through to the opposite side if
    // those actions exist), but can't go deeper into the side it's
    // already at. From rest (start = 0) all motion is unrestricted up
    // to the per-side max.
    if (startOffsetRef.current < 0) {
      newOffset = Math.max(newOffset, startOffsetRef.current);
    } else if (startOffsetRef.current > 0) {
      newOffset = Math.min(newOffset, startOffsetRef.current);
    }
    const maxRight = leadingActions.length > 0 ? 300 : 0;
    const maxLeft = trailingActions.length > 0 ? 300 : 0;
    newOffset = Math.max(-maxLeft, Math.min(maxRight, newOffset));
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
    const snapPosition = actions.length * 60 + 6;

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
        overflow: 'hidden',
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
          // top inset matches the card's bottom-face peek so the buttons
          // span only the top-face region. bottom:6 trims the buttons by
          // 6px from below — combined with the unchanged top, that shifts
          // their visual center up by 3px and reduces total height by 6.
          // right:3 nudges the trailing-side buttons 3px in from the
          // cell's right edge.
          top: bottomPeek,
          left: 0,
          right: 3,
          bottom: 6,
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
                <div style={{ color: action.iconColor ?? '#FFFFFF', display: 'flex' }}>
                  {action.icon}
                </div>
              </SunkenPushDownButton>
            </div>
          ))}
        </div>
      )}
      {/* Main content */}
      <div
        style={{
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
          }
        }}
        onClick={Math.abs(offset) > 10 ? () => setOffset(0) : undefined}
      >
        {children}
      </div>
    </div>
  );
}
