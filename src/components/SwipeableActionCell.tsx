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
  const startOffsetRef = useRef(0);
  const isDraggingRef = useRef(false);

  const handlePointerDown = (e: React.PointerEvent) => {
    isDraggingRef.current = true;
    startXRef.current = e.clientX;
    startOffsetRef.current = offset;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDraggingRef.current) return;
    const dx = e.clientX - startXRef.current;
    let newOffset = startOffsetRef.current + dx;

    const maxRight = leadingActions.length > 0 ? 300 : 0;
    const maxLeft = trailingActions.length > 0 ? 300 : 0;
    newOffset = Math.max(-maxLeft, Math.min(maxRight, newOffset));
    setOffset(newOffset);
  };

  const handlePointerUp = () => {
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
