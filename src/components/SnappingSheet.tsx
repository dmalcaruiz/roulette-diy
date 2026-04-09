import { useState, useRef, useCallback, useEffect } from 'react';

interface SnappingSheetProps {
  /** Snap positions in px from bottom of viewport, ascending order */
  snapPositions: number[];
  /** Index into snapPositions to start at */
  initialSnap?: number;
  /** Bottom offset (e.g. height of controls bar beneath the sheet) */
  bottomOffset?: number;
  /** Called when sheet is dragged to lowest snap */
  onCollapsed?: () => void;
  /** Called with current height in px as sheet moves */
  onHeightChange?: (h: number) => void;
  children: React.ReactNode;
  visible: boolean;
}

export default function SnappingSheet({
  snapPositions,
  initialSnap = 1,
  bottomOffset = 0,
  onCollapsed,
  onHeightChange,
  children,
  visible,
}: SnappingSheetProps) {
  const [currentSnap, setCurrentSnap] = useState(initialSnap);
  const [dragOffset, setDragOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const startYRef = useRef(0);
  const startHeightRef = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef(0);

  const targetHeight = visible ? snapPositions[currentSnap] ?? snapPositions[0] : 0;
  const displayHeight = dragging ? startHeightRef.current - dragOffset : targetHeight;

  // During drag, report directly
  useEffect(() => {
    if (dragging) {
      onHeightChange?.(displayHeight);
    }
  }, [dragging, displayHeight, onHeightChange]);

  // After release, poll the actual rendered height during CSS transition
  const startAnimationTracking = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    const el = containerRef.current;
    if (!el || !onHeightChange) return;
    let lastH = -1;
    const tick = () => {
      const h = el.offsetHeight;
      if (h !== lastH) {
        lastH = h;
        onHeightChange(h);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    setTimeout(() => cancelAnimationFrame(rafRef.current), 500);
  }, [onHeightChange]);

  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  // Track opening animation so wheel resizes immediately
  useEffect(() => {
    if (visible) {
      setCurrentSnap(initialSnap);
    } else {
      setCurrentSnap(0);
    }
    requestAnimationFrame(() => startAnimationTracking());
  }, [visible, initialSnap, startAnimationTracking]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    startYRef.current = e.clientY;
    startHeightRef.current = targetHeight;
    setDragging(true);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [targetHeight]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging) return;
    setDragOffset(e.clientY - startYRef.current);
  }, [dragging]);

  const onPointerUp = useCallback(() => {
    if (!dragging) return;
    setDragging(false);

    const finalHeight = startHeightRef.current - dragOffset;

    // Find nearest snap position
    let bestIndex = 0;
    let bestDist = Infinity;
    for (let i = 0; i < snapPositions.length; i++) {
      const dist = Math.abs(snapPositions[i] - finalHeight);
      if (dist < bestDist) {
        bestDist = dist;
        bestIndex = i;
      }
    }

    setCurrentSnap(bestIndex);
    setDragOffset(0);
    startAnimationTracking();

    if (bestIndex === 0) {
      onCollapsed?.();
    }
  }, [dragging, dragOffset, snapPositions, onCollapsed, startAnimationTracking]);

  if (!visible && displayHeight <= 0) return null;

  return (
    <div
      ref={containerRef}
      style={{
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: bottomOffset,
        height: Math.max(0, displayHeight),
        zIndex: 50,
        display: 'flex',
        flexDirection: 'column',
        transition: dragging ? 'none' : 'height 0.45s cubic-bezier(0.16, 1, 0.3, 1)',
        overflow: 'hidden',
      }}
    >
      {/* Sheet container */}
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: '#FFFFFF',
        borderRadius: '24px 24px 0 0',
        border: '1.5px solid #E4E4E7',
        borderBottom: 'none',
        overflow: 'hidden',
      }}>
        {/* Grabbing handle */}
        <div
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          style={{
            padding: '12px 0 8px',
            cursor: 'grab',
            touchAction: 'none',
            flexShrink: 0,
          }}
        >
          <div style={{
            width: 40, height: 4,
            backgroundColor: '#D4D4D8',
            borderRadius: 2,
            margin: '0 auto',
          }} />
        </div>

        {/* Scrollable content */}
        <div style={{ flex: 1, overflow: 'auto' }}>
          {children}
        </div>
      </div>
    </div>
  );
}
