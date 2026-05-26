import { useState, useRef, useCallback, useEffect } from 'react';
import { SURFACE, BORDER } from '../utils/constants';
import { oklchShadow, oklchHighlight } from '../utils/colorUtils';

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

  // Solapa stagger — when the sheet flips visible, delay 90ms then
  // slide the close-tab up into view. Short delay + tight animation
  // keeps it feeling like a single coordinated reveal rather than a
  // distracting second beat. When the sheet hides, the tab hides
  // instantly (no exit animation, since the sheet's height collapse
  // already removes the tab from view by carrying it down).
  const [solapaShown, setSolapaShown] = useState(false);
  useEffect(() => {
    if (visible) {
      const t = setTimeout(() => setSolapaShown(true), 90);
      return () => clearTimeout(t);
    } else {
      setSolapaShown(false);
    }
  }, [visible]);

  // 100ms debounce on the combined show/hide condition (visibility +
  // snap position) — gives the solapa a small lag relative to snap
  // transitions so it doesn't fight the sheet's own slide animation
  // when the user is moving between snaps quickly.
  const shouldShowSolapa = solapaShown && currentSnap !== snapPositions.length - 1;
  const [shouldShowSolapaDelayed, setShouldShowSolapaDelayed] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShouldShowSolapaDelayed(shouldShowSolapa), 50);
    return () => clearTimeout(t);
  }, [shouldShowSolapa]);

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
        // overflow:visible so the close-button solapa can peek ABOVE
        // the sheet's top edge without being clipped.
        overflow: 'visible',
      }}
    >
      {/* Close-button solapa — rendered BEFORE the sheet container so
          the sheet's opaque bg paints over its lower half (DOM order =
          stacking order at the same z level). The upper portion peeks
          above the sheet's rounded top edge, on the right side. Tapping
          snaps to 0 (fires onCollapsed). */}
      <button
        onClick={() => {
          // Flip solapaShown false IMMEDIATELY so the tab slides back
          // down in lockstep with the sheet's height collapse — without
          // this it stays at translateY(0) while the sheet shrinks,
          // ending up briefly hovering near the chip bar before the
          // visibility-driven unmount fires.
          setSolapaShown(false);
          snapToNearest(0);
        }}
        aria-label="Close"
        style={{
          position: 'absolute',
          // Height = the visible peek only. Positioned so the bottom
          // sits exactly at the sheet's top edge (y=0), no hidden
          // overlap — so a manual drag-down can never expose any
          // extra solapa underneath.
          top: -36,
          right: 16,
          width: 40,
          height: 36,
          borderRadius: '999px 999px 0 0',
          backgroundColor: oklchShadow(SURFACE, 0.02),
          // 3px inner stroke, lighter than the sheet bg (OKLCh-highlight
          // of SURFACE) so the tab edge reads as a raised pill on the
          // darker bg below. Bottom stroke removed so the tab visually
          // fuses with the sheet's top edge.
          borderTop: `3px solid ${oklchHighlight(SURFACE, 0.02)}`,
          borderLeft: `3px solid ${oklchHighlight(SURFACE, 0.02)}`,
          borderRight: `3px solid ${oklchHighlight(SURFACE, 0.02)}`,
          padding: 0,
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'center',
          paddingTop: 9,
          cursor: 'pointer',
          // Stagger entrance — start hidden below the sheet's top edge
          // (translateY pushes the whole pill down into the sheet), then
          // slide up to its natural position after the 220ms delay set
          // in the effect above. The sheet's own open animation runs
          // first, then the tab pops up over it for a layered reveal.
          // Hidden state pushes the tab 120px down — enough that it
          // ends up below the chip bar (off-screen) even after the
          // sheet's height collapses to 0 and the outer container's
          // top drops onto the chip bar's level. translateY(50) was
          // only enough to land it INSIDE the chip bar area, where it
          // lingered visibly during the 0.45s height transition.
          // At the upper snap the solapa also hides — the same
          // translateY(120) slide-down — so it doesn't clutter the
          // fully-expanded sheet's header area.
          // When solapaShown is false (sheet is closing / collapsed),
          // jump to the hidden translateY directly — bypass the debounced
          // shouldShowSolapaDelayed so the solapa snaps off-screen
          // instead of lingering visible during the 50ms debounce.
          transform: (solapaShown && shouldShowSolapaDelayed)
            ? 'translateY(0)'
            : 'translateY(120px)',
          // Only animate while solapaShown is true (i.e. the sheet is
          // open and not closing). That way:
          //  - Reveal animates (ease-out, 0.35s).
          //  - Hide due to reaching the upper snap animates (ease-in-out,
          //    0.5s) — the only case where a slow deliberate exit reads.
          //  - Hide due to drag-down / tap-to-close snaps off instantly
          //    (transition:none), matching the sheet's own collapse
          //    rather than dragging out a separate fade-away.
          transition: solapaShown
            ? (shouldShowSolapaDelayed
                ? 'transform 0.35s cubic-bezier(0.16, 1, 0.3, 1)'
                : 'transform 0.5s cubic-bezier(0.4, 0, 0.6, 1)')
            : 'none',
        }}
      >
        <div style={{
          width: 22,
          height: 22,
          backgroundColor: '#FFFFFF',
          WebkitMaskImage: 'url(/images/close.svg)',
          WebkitMaskRepeat: 'no-repeat',
          WebkitMaskSize: 'contain',
          WebkitMaskPosition: 'center',
          maskImage: 'url(/images/close.svg)',
          maskRepeat: 'no-repeat',
          maskSize: 'contain',
          maskPosition: 'center',
        }} />
      </button>
      {/* Sheet container — 3px black-20% inner stroke on top + sides
          only; no bottom border so the sheet blends straight into the
          edge of the viewport / chip bar beneath. */}
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: SURFACE,
        borderRadius: '24px 24px 0 0',
        borderTop: '3px solid rgba(0, 0, 0, 0.2)',
        borderLeft: '3px solid rgba(0, 0, 0, 0.2)',
        borderRight: '3px solid rgba(0, 0, 0, 0.2)',
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
            backgroundColor: BORDER,
            borderRadius: 2,
            margin: '0 auto',
          }} />
        </div>

        {/* Scrollable content */}
        <div
          ref={scrollRef}
          className="hide-scrollbar"
          onPointerDown={onScrollPointerDown}
          onPointerMove={onScrollPointerMove}
          onPointerUp={onScrollPointerUp}
          onPointerCancel={onScrollPointerUp}
          style={{
            flex: 1,
            overflowY: 'auto',
            overflowX: 'hidden',
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
