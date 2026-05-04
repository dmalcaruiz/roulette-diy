import { useState, useRef, useCallback, useEffect } from 'react';
import { X } from 'lucide-react';

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
  /** Returns true when sheet drag gestures should be suppressed. Checked
   *  synchronously inside every pointer handler, so a competing gesture
   *  inside the sheet (e.g. drag-to-reorder a list item) can flip the
   *  lock via a ref and have it picked up on the very next pointermove
   *  — no React-render delay. Any in-flight scroll-drag is released the
   *  first time a locked move arrives. */
  isDragLocked?: () => boolean;
  children: React.ReactNode;
  visible: boolean;
}

export default function SnappingSheet({
  snapPositions,
  initialSnap = 1,
  bottomOffset = 0,
  onCollapsed,
  onHeightChange,
  isDragLocked,
  children,
  visible,
}: SnappingSheetProps) {
  const [currentSnap, setCurrentSnap] = useState(initialSnap);
  const [dragOffset, setDragOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const startYRef = useRef(0);
  const startHeightRef = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef(0);

  // Scroll-to-drag handoff state
  const isScrollDraggingRef = useRef(false);
  const scrollDragStartYRef = useRef(0);
  const scrollDragPointerIdRef = useRef<number | null>(null);
  const [scrollDragOffset, setScrollDragOffset] = useState(0);
  const scrollDragActiveRef = useRef(false); // true once we've committed to dragging
  const returnToScrollRef = useRef(false);

  const targetHeight = visible ? snapPositions[currentSnap] ?? snapPositions[0] : 0;
  const displayHeight = dragging
    ? startHeightRef.current - dragOffset
    : isScrollDraggingRef.current
      ? targetHeight - scrollDragOffset
      : targetHeight;

  // Keep the latest onHeightChange in a ref so the pointer handlers (which
  // must run synchronously with their own setState to avoid a 1-frame lag)
  // don't need it as a useCallback dependency.
  const onHeightChangeRef = useRef(onHeightChange);
  onHeightChangeRef.current = onHeightChange;

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

  // Keep mounted while a close animation runs so the height transition can
  // play out instead of unmounting the sheet immediately when visible flips.
  const [keepMounted, setKeepMounted] = useState(false);
  useEffect(() => {
    if (!visible) {
      setKeepMounted(true);
      const t = setTimeout(() => setKeepMounted(false), 500);
      return () => clearTimeout(t);
    }
    setKeepMounted(false);
  }, [visible]);

  // Cancels any in-flight handle-drag or scroll-drag. Called synchronously
  // from the pointer handlers the moment isDragLocked() goes true, so the
  // sheet snaps back to its current snap target rather than stranding
  // mid-drag with no further events arriving.
  const releaseInFlightDrag = useCallback(() => {
    if (dragging) {
      setDragging(false);
      setDragOffset(0);
    }
    if (isScrollDraggingRef.current) {
      isScrollDraggingRef.current = false;
      scrollDragActiveRef.current = false;
      scrollDragPointerIdRef.current = null;
      setScrollDragOffset(0);
      const scrollEl = scrollRef.current;
      if (scrollEl) scrollEl.style.overflowY = 'auto';
    }
  }, [dragging]);

  // ── Handle grab bar drag ──────────────────────────────────────────
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (isDragLocked?.()) return;
    startYRef.current = e.clientY;
    startHeightRef.current = targetHeight;
    setDragging(true);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [targetHeight, isDragLocked]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (isDragLocked?.()) { releaseInFlightDrag(); return; }
    if (!dragging) return;
    const dy = e.clientY - startYRef.current;
    setDragOffset(dy);
    // Report synchronously so the parent's game container re-renders in the
    // same React commit as the sheet itself — otherwise the red footer lags
    // by a frame behind the sheet during drag.
    onHeightChangeRef.current?.(startHeightRef.current - dy);
  }, [dragging, isDragLocked, releaseInFlightDrag]);

  const onPointerUp = useCallback(() => {
    if (!dragging) return;
    setDragging(false);
    snapToNearest(startHeightRef.current - dragOffset);
  }, [dragging, dragOffset]);

  // ── Scroll-to-drag handoff on content area ────────────────────────
  const onScrollPointerDown = useCallback((e: React.PointerEvent) => {
    if (isDragLocked?.()) return;
    scrollDragStartYRef.current = e.clientY;
    scrollDragPointerIdRef.current = e.pointerId;
    scrollDragActiveRef.current = false;
    returnToScrollRef.current = false;
    isScrollDraggingRef.current = false;
    setScrollDragOffset(0);
  }, [isDragLocked]);

  const onScrollPointerMove = useCallback((e: React.PointerEvent) => {
    if (isDragLocked?.()) { releaseInFlightDrag(); return; }
    if (scrollDragPointerIdRef.current !== e.pointerId) return;
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;

    const dy = e.clientY - scrollDragStartYRef.current;
    const atTop = scrollEl.scrollTop <= 0;

    if (isScrollDraggingRef.current) {
      // Currently in drag mode
      if (dy <= 0 && scrollDragActiveRef.current) {
        // User reversed direction back up — return to scroll
        isScrollDraggingRef.current = false;
        scrollDragActiveRef.current = false;
        returnToScrollRef.current = true;
        setScrollDragOffset(0);
        // Reset the start Y so future movements scroll naturally
        scrollDragStartYRef.current = e.clientY;
        return;
      }
      const offset = Math.max(0, dy);
      setScrollDragOffset(offset);
      onHeightChangeRef.current?.(targetHeight - offset);
      e.preventDefault();
    } else if (!returnToScrollRef.current && atTop && dy > 5) {
      // At scroll top, pulling down — switch to sheet drag
      isScrollDraggingRef.current = true;
      scrollDragActiveRef.current = true;
      scrollDragStartYRef.current = e.clientY;
      scrollEl.style.overflowY = 'hidden';
      setScrollDragOffset(0);
      e.preventDefault();
    }
  }, [targetHeight, isDragLocked, releaseInFlightDrag]);

  const onScrollPointerUp = useCallback(() => {
    const scrollEl = scrollRef.current;

    if (isScrollDraggingRef.current) {
      isScrollDraggingRef.current = false;
      scrollDragActiveRef.current = false;
      if (scrollEl) scrollEl.style.overflowY = 'auto';
      snapToNearest(targetHeight - scrollDragOffset);
      setScrollDragOffset(0);
    } else {
      if (scrollEl) scrollEl.style.overflowY = 'auto';
    }

    scrollDragPointerIdRef.current = null;
    returnToScrollRef.current = false;
  }, [targetHeight, scrollDragOffset]);

  // ── Shared snap logic ─────────────────────────────────────────────
  const snapToNearest = useCallback((finalHeight: number) => {
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
  }, [snapPositions, onCollapsed, startAnimationTracking]);

  if (!visible && !keepMounted && displayHeight <= 0) return null;

  return (
    <div
      ref={containerRef}
      style={{
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: bottomOffset,
        height: Math.max(0, displayHeight),
        zIndex: 70,
        display: 'flex',
        flexDirection: 'column',
        transition: (dragging || isScrollDraggingRef.current) ? 'none' : 'height 0.45s cubic-bezier(0.16, 1, 0.3, 1)',
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
        position: 'relative',
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
        {/* Top-right close button — snaps to 0 which invokes onCollapsed. */}
        <button
          onClick={() => snapToNearest(0)}
          aria-label="Close"
          style={{
            position: 'absolute',
            top: 12,
            right: 14,
            width: 32,
            height: 32,
            borderRadius: 50,
            backgroundColor: '#F4F4F5',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: 'none',
            cursor: 'pointer',
            zIndex: 2,
          }}
        >
          <X size={16} color="#1E1E2C" />
        </button>

        {/* Scrollable content */}
        <div
          ref={scrollRef}
          onPointerDown={onScrollPointerDown}
          onPointerMove={onScrollPointerMove}
          onPointerUp={onScrollPointerUp}
          onPointerCancel={onScrollPointerUp}
          style={{
            flex: 1,
            overflowY: 'auto',
            overscrollBehavior: 'none',
            touchAction: 'pan-y',
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
