import { useState, useRef, type ReactNode, type CSSProperties } from 'react';
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
}

export default function SwipeableActionCell({
  children,
  leadingActions = [],
  trailingActions = [],
  fullSwipeThreshold = 0.55,
  style,
}: SwipeableActionCellProps) {
  const [offset, setOffset] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const startXRef = useRef(0);
  const startYRef = useRef(0);
  const startOffsetRef = useRef(0);
  const isPendingRef = useRef(false);
  const isDraggingRef = useRef(false);
  const didSwipeRef = useRef(false);

  const handlePointerDown = (e: React.PointerEvent) => {
    isPendingRef.current = true;
    isDraggingRef.current = false;
    didSwipeRef.current = false;
    startXRef.current = e.clientX;
    startYRef.current = e.clientY;
    startOffsetRef.current = offset;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isPendingRef.current && !isDraggingRef.current) return;

    const dx = e.clientX - startXRef.current;
    const dy = e.clientY - startYRef.current;

    if (isPendingRef.current) {
      if (Math.abs(dx) > 10) {
        // Horizontal movement — start swiping
        isPendingRef.current = false;
        isDraggingRef.current = true;
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
    const maxRight = leadingActions.length > 0 ? 300 : 0;
    const maxLeft = trailingActions.length > 0 ? 300 : 0;
    newOffset = Math.max(-maxLeft, Math.min(maxRight, newOffset));
    setOffset(newOffset);
  };

  const handlePointerUp = () => {
    isPendingRef.current = false;

    if (!isDraggingRef.current) return;
    isDraggingRef.current = false;

    const absOffset = Math.abs(offset);
    const containerWidth = containerRef.current?.offsetWidth ?? 300;
    const threshold = containerWidth * fullSwipeThreshold;

    const actions = offset > 0 ? leadingActions : trailingActions;
    const snapPosition = actions.length * 68 + 12;

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

  const actions = offset < 0 ? trailingActions : offset > 0 ? leadingActions : [];
  const isLeading = offset > 0;

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
      {/* Action buttons behind */}
      {offset !== 0 && (
        <div style={{
          position: 'absolute',
          inset: 0,
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
              style={{ width: 60, cursor: 'pointer' }}
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
          transition: isDraggingRef.current ? 'none' : 'transform 0.15s ease-out',
        }}
        onClick={Math.abs(offset) > 10 ? () => setOffset(0) : undefined}
      >
        {children}
      </div>
    </div>
  );
}
