import { useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react';
import { SURFACE } from '../utils/constants';
import { lerpColor, hexToRgba } from '../utils/colorUtils';
import { pixelateCanvas, PIXELATED, type Palette } from './WheelCanvas';
import { rrPath } from './PixelCard';

// Pixel-chrome geometry (used when `pixelScale` is set): the sheet's rounded
// top corners + border band are baked onto a small canvas strip quantized to
// the wheel's block grid; below the strip the sides are plain straight
// borders (a straight line pixelates to itself, so no canvas needed there).
const SHEET_RADIUS = 24;
const SHEET_BORDER = 3;
const CHROME_STRIP_H = SHEET_RADIUS + SHEET_BORDER + 5; // corners + border + margin

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
  /** Programmatic snap request: when set (and the sheet is visible), snap to
   *  this index of `snapPositions` with a gentle glide. Ignored mid-drag —
   *  the user's finger owns the sheet. The parent keeps/clears the value;
   *  re-snapping only happens when the VALUE changes. */
  snapToIndex?: number | null;
  /** Dismiss line (px height): releasing a drag BELOW this closes the sheet
   *  outright, overriding nearest-snap math — a much shorter pull-to-dismiss
   *  than dragging halfway to 0. While the drag is under the line, the content
   *  dims (50% black) with an ✕ badge: "release to close". */
  dismissBelow?: number;
  /** CSS px per pixel-block (the wheel's snapped block size). When set, the
   *  sheet chrome — rounded top corners + border — renders as pixel-art on
   *  the wheel's grid (canvas strip, hard palette, zero AA) instead of the
   *  smooth CSS border-radius. */
  pixelScale?: number;
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
  snapToIndex = null,
  dismissBelow,
  pixelScale,
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

  // ── Pixel chrome (pixelScale set) ──────────────────────────────────
  // Top strip canvas: rounded-top silhouette + border band, quantized to the
  // wheel grid. Repaints only on WIDTH changes — never during drags (height
  // changes don't touch it), so it costs nothing on the hot path. The border
  // colour is the old rgba(0,0,0,0.2) pre-blended over SURFACE (the palette
  // snap needs opaque colours; visually identical since the border always
  // sat on the sheet's own fill).
  const chromeCanvasRef = useRef<HTMLCanvasElement>(null);
  const [chromeW, setChromeW] = useState(0);
  const pixelChrome = pixelScale != null && pixelScale > 0;
  const chromeBorderColor = lerpColor(SURFACE, '#000000', 0.2);
  // Border width quantized to whole blocks so the band survives pixelation
  // at uniform thickness, and the straight side borders below the strip can
  // use the exact same width (the two must meet seamlessly at the seam).
  const chromeBorderW = pixelChrome ? Math.max(1, Math.round(SHEET_BORDER / pixelScale!)) * pixelScale! : SHEET_BORDER;
  useLayoutEffect(() => {
    if (!pixelChrome) return;
    const el = containerRef.current;
    if (!el) return;
    const update = () => setChromeW(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [pixelChrome]);
  useLayoutEffect(() => {
    if (!pixelChrome || chromeW <= 0) return;
    const canvas = chromeCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== chromeW * dpr || canvas.height !== CHROME_STRIP_H * dpr) {
      canvas.width = chromeW * dpr;
      canvas.height = CHROME_STRIP_H * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, chromeW, CHROME_STRIP_H);
    // Silhouette slice: a rounded-top rect that extends past the strip's
    // bottom edge (the canvas crops it), so only the corners + top band are
    // drawn here; below the strip the body div takes over with straight sides.
    ctx.fillStyle = chromeBorderColor;
    ctx.fill(rrPath(0, 0, chromeW, CHROME_STRIP_H + SHEET_RADIUS, SHEET_RADIUS));
    ctx.fillStyle = SURFACE;
    ctx.fill(rrPath(chromeBorderW, chromeBorderW, chromeW - chromeBorderW, CHROME_STRIP_H + SHEET_RADIUS, Math.max(0, SHEET_RADIUS - chromeBorderW)));
    const palette: Palette = [chromeBorderColor, SURFACE].map(h => {
      const { r, g, b } = hexToRgba(h);
      return [r, g, b] as [number, number, number];
    });
    if (PIXELATED) pixelateCanvas(ctx, chromeW, CHROME_STRIP_H, pixelScale!, palette);
  }, [pixelChrome, chromeW, pixelScale, chromeBorderColor, chromeBorderW]);

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

  // Programmatic snaps (the dock) animate with their own GENTLE profile — a
  // longer, decelerating glide with no bounce. The user-release curve reads
  // punchy under a finger but harsh on a motion nobody initiated. The flag is
  // consumed by the render that starts the transition (running transitions
  // keep their starting curve) and cleared on the following commit.
  const gentleSnapRef = useRef(false);
  useEffect(() => { gentleSnapRef.current = false; }); // clears AFTER the flagged render commits

  // Programmatic snap request (see the prop doc). Each VALUE is consumed at
  // most once — the consumed ref is what makes later effect re-runs (e.g.
  // `dragging` flipping back to false on a release) inert, otherwise every
  // drag release would yank the sheet back to the requested index. A request
  // arriving mid-drag is dropped, not replayed: the finger owns the sheet.
  const consumedSnapToIndexRef = useRef<number | null>(null);
  useEffect(() => {
    if (consumedSnapToIndexRef.current === snapToIndex) return;
    consumedSnapToIndexRef.current = snapToIndex;
    if (snapToIndex == null || !visible) return;
    if (dragging || isScrollDraggingRef.current) return;
    gentleSnapRef.current = true;
    setCurrentSnap(i => (i === snapToIndex ? i : snapToIndex));
  }, [snapToIndex, visible, dragging]);

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
    // Released under the dismiss line → close outright (skip nearest-snap
    // math, which would only dismiss below snap1/2 — far more pull).
    if (!(dismissBelow != null && finalHeight < dismissBelow)) {
      let bestDist = Infinity;
      for (let i = 0; i < snapPositions.length; i++) {
        const dist = Math.abs(snapPositions[i] - finalHeight);
        if (dist < bestDist) {
          bestDist = dist;
          bestIndex = i;
        }
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
  }, [snapPositions, onCollapsed, dismissBelow]);

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
        transition: (dragging || isScrollDraggingRef.current || disableHeightTransition)
          ? 'none'
          : gentleSnapRef.current
            // Dock: anticipation wind-up then glide. The NEGATIVE first control
            // point makes the value dip ~6% below the start (the sheet sinks a
            // few px, like an inhale) before the long decelerating rise — reads
            // as an intentional "gather → dock" instead of a stray drift.
            ? 'height 0.6s cubic-bezier(0.45, -0.35, 0.2, 1)'
            : `height 0.28s ${rising ? SHEET_EASE_BOUNCE : SHEET_EASE}`,
        overflow: 'visible',
      }}
    >
      {/* Sheet container — 3px black-20% inner stroke on top + sides
          only; no bottom border so the sheet blends straight into the
          edge of the viewport / chip bar beneath. With `pixelScale` the
          chrome is the pixel-art canvas strip + straight-side body layers
          below (background/border live on THOSE layers, not here). */}
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: pixelChrome ? 'transparent' : SURFACE,
        borderRadius: pixelChrome ? 0 : '24px 24px 0 0',
        borderTop: pixelChrome ? undefined : '3px solid rgba(0, 0, 0, 0.2)',
        borderLeft: pixelChrome ? undefined : '3px solid rgba(0, 0, 0, 0.2)',
        borderRight: pixelChrome ? undefined : '3px solid rgba(0, 0, 0, 0.2)',
        overflow: 'hidden',
        position: 'relative',
      }}>
        {pixelChrome && (
          <>
            {/* Pixel top strip: corners + top border band (canvas, wheel-grid
                quantized). Below it, the body layer carries the fill + the
                straight side borders at the SAME quantized width, meeting the
                strip flush. Both sit under the (relative, z≥1) content. */}
            <canvas
              ref={chromeCanvasRef}
              style={{
                position: 'absolute', top: 0, left: 0, right: 0,
                width: '100%', height: CHROME_STRIP_H,
                imageRendering: PIXELATED ? 'pixelated' : undefined,
                pointerEvents: 'none',
              }}
            />
            <div style={{
              position: 'absolute', top: CHROME_STRIP_H, left: 0, right: 0, bottom: 0,
              backgroundColor: SURFACE,
              borderLeft: `${chromeBorderW}px solid ${chromeBorderColor}`,
              borderRight: `${chromeBorderW}px solid ${chromeBorderColor}`,
              boxSizing: 'border-box',
              pointerEvents: 'none',
            }} />
          </>
        )}
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
            // Above the absolute pixel-chrome layers (no-op otherwise).
            position: 'relative',
            zIndex: 1,
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
            style={{ flexShrink: 0, touchAction: 'none', cursor: 'grab', position: 'relative', zIndex: 1 }}
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
            // Above the absolute pixel-chrome layers (no-op otherwise).
            position: 'relative',
            zIndex: 1,
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

        {/* Release-to-close affordance: while a drag holds the sheet BELOW the
            dismiss line, dim everything 50% and show an ✕ — "let go and it
            closes". Fades with opacity so crossing the line back and forth
            reads smooth; pointer-events none keeps the drag alive under it. */}
        {dismissBelow != null && (
          <div style={{
            position: 'absolute', inset: 0, zIndex: 3,
            // Rounded to the sheet silhouette — with the pixel chrome the
            // container no longer clips corners, so the dim would otherwise
            // poke square corners past the strip's transparent cutouts.
            borderRadius: '24px 24px 0 0',
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
            opacity: (dragging || isScrollDraggingRef.current) && displayHeight > 0 && displayHeight < dismissBelow ? 1 : 0,
            transition: 'opacity 0.15s ease',
            pointerEvents: 'none',
          }}>
            {/* ✕ pinned to the sheet's TOP edge (not flex-centered): the top
                edge is what tracks the finger, so the badge stays put — no
                per-frame recentering as the height shrinks. */}
            <svg
              width="44" height="44" viewBox="0 0 24 24" fill="none"
              stroke="#FFFFFF" strokeWidth="2.5" strokeLinecap="round"
              style={{ position: 'absolute', top: 26, left: '50%', transform: 'translateX(-50%)' }}
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </div>
        )}
      </div>
    </div>
  );
}
