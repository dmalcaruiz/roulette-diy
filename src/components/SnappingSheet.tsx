import { useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react';
import { SURFACE } from '../utils/constants';

// Snap easing pair — exported so lockstep siblings (RouletteScreen's wheel
// transition) can mirror the sheet exactly, bounce included, or the two
// visibly drift apart mid-animation.
export const SHEET_EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';
// Rising snaps only: slight back-out overshoot (~5%) for the game-feel bounce.
export const SHEET_EASE_BOUNCE = 'cubic-bezier(0.32, 1.3, 0.42, 1)';

interface SnappingSheetProps {
  /** Snap positions in px from bottom of viewport, ascending order */
  snapPositions: number[];
  /** Index into snapPositions to start at */
  initialSnap?: number;
  /** Bottom offset (e.g. height of controls bar beneath the sheet) */
  bottomOffset?: number;
  /** Called when sheet is dragged to lowest snap */
  onCollapsed?: () => void;
  /** Called with current height in px as sheet moves. `committed` is
   *  true only at discrete snap targets (drag release, visibility flip,
   *  snap-to commit) — used by callers to distinguish per-frame ticks
   *  from settled-snap moments so they can skip expensive work during
   *  continuous moves. */
  onHeightChange?: (h: number, committed?: boolean) => void;
  /** Returns true when sheet drag gestures should be suppressed. Checked
   *  synchronously inside every pointer handler, so a competing gesture
   *  inside the sheet (e.g. drag-to-reorder a list item) can flip the
   *  lock via a ref and have it picked up on the very next pointermove
   *  — no React-render delay. Any in-flight scroll-drag is released the
   *  first time a locked move arrives. */
  isDragLocked?: () => boolean;
  children: React.ReactNode;
  /** Optional bar pinned to the BOTTOM of the sheet, overlaid on top of the
   *  scrollable content (absolute — doesn't affect sheet height or the scroll
   *  area). Give the scrollable content enough bottom padding to clear it. */
  footer?: React.ReactNode;
  /** Optional title section fixed to the TOP of the sheet (above the scroll
   *  area, never scrolls). It's wired as a drag handle so dragging it moves the
   *  sheet reliably. */
  header?: React.ReactNode;
  visible: boolean;
  /** Optional ref exposing the sheet's outer container — used by
   *  external debug code that needs to read live bounding rects. */
  outerRef?: React.MutableRefObject<HTMLDivElement | null>;
  /** When true, keep the sheet (and its children) mounted across
   *  close/open cycles. Used by callers whose children are expensive
   *  to mount — they trade a bit of memory for a much faster re-open.
   *  Named `keepAlive` (not `keepMounted`) because there's an internal
   *  `keepMounted` state below for the close-animation grace period. */
  keepAlive?: boolean;
  /** When true, suppresses the height transition. Used to skip the
   *  open animation when the child is expensive to render (e.g. a wheel
   *  with many segments) so the sheet snaps to its target height in a
   *  single frame instead of dragging the heavy child through 28 paints
   *  of a 450ms animation. */
  disableHeightTransition?: boolean;
  /** Fires whenever the sheet's snap target changes — visibility flip,
   *  drag-release snap, or X-button close. Parent uses this to drive
   *  matching CSS transitions on sibling elements (e.g. wheel size) so
   *  they animate in lockstep with the sheet without going through any
   *  per-frame JS callback. `instant=true` means the sheet itself is
   *  jumping to this target with no transition (X-close path) — the
   *  caller should match it (disable its own transition for this
   *  commit) to keep the elements in sync. */
  onSnapTargetChange?: (targetHeight: number, instant?: boolean) => void;
  /** Fires on pointerdown of the grab handle OR when the scroll-to-drag
   *  handoff engages. Parent uses this to switch sibling animations
   *  into "drag mode" (no CSS transition, imperative per-pointer-move
   *  updates) so they track the finger 1:1 instead of easing toward
   *  whatever the next snap target is. */
  onDragStart?: () => void;
  /** Fires on pointerup / pointercancel when a drag ends — paired with
   *  `onDragStart`. */
  onDragEnd?: () => void;
}

export default function SnappingSheet({
  snapPositions,
  initialSnap = 1,
  bottomOffset = 0,
  onCollapsed,
  onHeightChange,
  isDragLocked,
  children,
  footer,
  header,
  visible,
  outerRef,
  keepAlive = false,
  disableHeightTransition = false,
  onSnapTargetChange,
  onDragStart,
  onDragEnd,
}: SnappingSheetProps) {
  // Stash the latest snap/drag callbacks in refs so pointer handlers
  // (which are wrapped in useCallback with their own deps) can call the
  // freshest version without forcing a re-create on every prop change.
  const onSnapTargetChangeRef = useRef(onSnapTargetChange);
  onSnapTargetChangeRef.current = onSnapTargetChange;
  const onDragStartRef = useRef(onDragStart);
  onDragStartRef.current = onDragStart;
  const onDragEndRef = useRef(onDragEnd);
  onDragEndRef.current = onDragEnd;
  // Set true momentarily right before an X-close fires its snapToNearest
  // — read + cleared by the snap-target useLayoutEffect so the parent
  // receives `instant=true` in the same commit it gets the new target.
  // This is the only way the X-close path (which uses an internal
  // instantClose flag) communicates "snap, don't animate" to the
  // wheel/margin transitions outside the sheet.
  const pendingInstantSnapRef = useRef(false);
  const [currentSnap, setCurrentSnap] = useState(initialSnap);
  const [dragOffset, setDragOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const startYRef = useRef(0);
  const startHeightRef = useRef(0);
  // Set true once a handle/X drag moves past a few px, so the X's onClick can
  // tell a real drag from a clean tap and skip the close on a drag-release.
  const didDragRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

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

  // NOTE: the old post-release "animation tracking" rAF poller is gone. It
  // read offsetHeight every frame for 500ms after EVERY snap — a forced
  // style+layout pass of the transitioning sheet (whole mounted editor) per
  // frame — purely to feed non-committed onHeightChange ticks that the
  // consumer drops anyway (RouletteScreen ignores per-rAF ticks outside
  // drags). Snap values are delivered by onSnapTargetChange plus the
  // committed onHeightChange at release/flip, all of which fire in the same
  // commit the CSS transition starts.

  // Sync currentSnap with `visible` during render (not in useEffect) so
  // it lands in the same React commit as the parent's prop changes —
  // critical for `disableHeightTransition`, which only needs to be true
  // for the single render where currentSnap moves from 0 → initialSnap.
  // If we did this in a useEffect, currentSnap would change one render
  // later, after the parent's one-frame `disableHeightTransition` flag
  // had already cleared, and the height would animate again.
  const [prevVisible, setPrevVisible] = useState(visible);
  if (visible !== prevVisible) {
    setPrevVisible(visible);
    setCurrentSnap(visible ? initialSnap : 0);
  }
  // Fire onSnapTargetChange whenever the effective target height
  // changes — using a useLayoutEffect (NOT render-time) because the
  // callback updates the parent's state. Layout-effect is synchronous
  // after commit + before paint, so the parent's CSS-transition target
  // value still lands BEFORE the browser paints the sheet's new
  // height — keeping wheel and sheet in lockstep. Target is 0 when
  // the sheet is hidden (regardless of currentSnap) so the wheel sits
  // at its closed size while invisible.
  const effectiveSnapTargetH = visible ? (snapPositions[currentSnap] ?? 0) : 0;
  useLayoutEffect(() => {
    const instant = pendingInstantSnapRef.current;
    pendingInstantSnapRef.current = false;
    onSnapTargetChangeRef.current?.(effectiveSnapTargetH, instant);
  }, [effectiveSnapTargetH]);


  // When `disableHeightTransition` is set during a visibility flip, fire
  // onHeightChange synchronously with the target height so the parent's
  // imperative wheel-resize handler runs in the same paint as the sheet
  // change — without this the wheel only catches up one rAF tick later
  // (when the height-polling tracker reports the new offsetHeight).
  useLayoutEffect(() => {
    if (!disableHeightTransition) return;
    onHeightChangeRef.current?.(visible ? (snapPositions[initialSnap] ?? 0) : 0, true);
  }, [visible, disableHeightTransition, initialSnap, snapPositions]);

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
    didDragRef.current = false;
    setDragging(true);
    onDragStartRef.current?.();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [targetHeight, isDragLocked]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (isDragLocked?.()) { releaseInFlightDrag(); return; }
    if (!dragging) return;
    const dy = e.clientY - startYRef.current;
    if (Math.abs(dy) > 4) didDragRef.current = true;
    setDragOffset(dy);
    // Report synchronously so the parent's game container re-renders in the
    // same React commit as the sheet itself — otherwise the red footer lags
    // by a frame behind the sheet during drag.
    onHeightChangeRef.current?.(startHeightRef.current - dy);
  }, [dragging, isDragLocked, releaseInFlightDrag]);

  const onPointerUp = useCallback(() => {
    if (!dragging) return;
    setDragging(false);
    onDragEndRef.current?.();
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
      onDragStartRef.current?.();
      e.preventDefault();
    }
  }, [targetHeight, isDragLocked, releaseInFlightDrag]);

  const onScrollPointerUp = useCallback(() => {
    const scrollEl = scrollRef.current;

    if (isScrollDraggingRef.current) {
      isScrollDraggingRef.current = false;
      scrollDragActiveRef.current = false;
      if (scrollEl) scrollEl.style.overflowY = 'auto';
      onDragEndRef.current?.();
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
    // Fire a `committed` onHeightChange with the snap's target height
    // so callers (e.g. RouletteScreen's wheel-scale handler) can react
    // to the snap commit immediately rather than waiting for the rAF
    // tracker to poll the new offsetHeight on the next frame.
    // (onSnapTargetChange fires automatically via the useLayoutEffect
    // on currentSnap above.)
    onHeightChangeRef.current?.(snapPositions[bestIndex] ?? 0, true);

    if (bestIndex === 0) {
      onCollapsed?.();
    }
  }, [snapPositions, onCollapsed]);

  // Slight game-feel bounce on RISING height changes (opens / snap-ups): a
  // back-out overshoot eases past the target then settles. Falling keeps the
  // plain decel — an overshoot on the way down would dip below the target
  // (or 0) and read as a glitch. The ref lags one commit behind, so the
  // render that raises the height sees rising=true; a RUNNING transition
  // keeps the curve it started with, so later renders flipping the string
  // are harmless. Lockstep siblings (RouletteScreen's wheel) mirror the
  // exported pair.
  const prevHeightRef = useRef(0);
  const rising = displayHeight > prevHeightRef.current;
  useEffect(() => { prevHeightRef.current = displayHeight; });

  if (!visible && !keepMounted && !keepAlive && displayHeight <= 0) return null;

  return (
    <div
      ref={el => {
        containerRef.current = el;
        if (outerRef) outerRef.current = el;
      }}
      style={{
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: bottomOffset,
        height: Math.max(0, displayHeight),
        zIndex: 70,
        display: 'flex',
        flexDirection: 'column',
        transition: (dragging || isScrollDraggingRef.current || disableHeightTransition) ? 'none' : `height 0.28s ${rising ? SHEET_EASE_BOUNCE : SHEET_EASE}`,
        overflow: 'visible',
      }}
    >
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
            // 9 top / 11 bottom nudges the bar 1px up from dead-center in the
            // handle's tap area (centered was 10/10, which read a touch low).
            padding: '9px 0 11px',
            cursor: 'grab',
            touchAction: 'none',
            flexShrink: 0,
          }}
        >
          <div style={{
            width: 44, height: 5,
            backgroundColor: 'rgba(0, 0, 0, 0.4)',
            borderRadius: 2.5,
            margin: '0 auto',
          }} />
        </div>

        {/* Fixed title section — never scrolls; wired as a drag handle (same
            pointer handlers as the grab bar) so dragging it moves the sheet. */}
        {header && (
          <div
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            style={{ flexShrink: 0, touchAction: 'none', cursor: 'grab' }}
          >
            {header}
          </div>
        )}

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

        {/* Footer bar — pinned to the sheet's bottom edge, overlaying the scroll
            content (absolute, so it doesn't change the sheet height or shrink the
            scroll area). The content padding-bottom keeps the last items clear. */}
        {footer && (
          <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 2 }}>
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
