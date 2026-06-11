import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { deriveCardSurfaces } from '../../utils/colorUtils';
import { SLICE_VIBES, vibePreview, isVibeActive, type SliceVibe } from './vibes';

// Horizontally-scrollable, drag-REORDERABLE row of vibe cards. The card UI copies
// the closed slice card's 3D look (bottom face + top face + halo); the drag /
// scroll / reorder interaction copies the wheel preview tiles. Order persists in
// localStorage. Tap a card to apply its palette; long-press to reorder.

const CARD_W = 96;
const GAP = 10;
const SLOT_WIDTH = CARD_W + GAP;
const RADIUS = 14;
const PEEK = 5;
// Press slides the top face down by LESS than the peek, so a sliver of the lower
// layer stays visible and the card keeps reading as a solid object.
const PRESS_DROP = 3;
const FACE_H = 52;
// Virtualisation: cards within ±BUFFER slots of the viewport render; the rest are
// reserved by spacers. Keeps a large vibe list cheap to scroll.
const BUFFER = 6;
const ORDER_KEY = 'wheelVibeOrder';
// Active = the halo simply turns white; nothing else.
const HALO_REST = '0 0 0 3.5px rgba(0,0,0,0.36)';
const HALO_ACTIVE = '0 0 0 3.5px rgba(255,255,255,0.92)';

const byKey = new Map(SLICE_VIBES.map(v => [v.key, v]));

function loadOrder(): string[] {
  try {
    const raw = localStorage.getItem(ORDER_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        const seen = new Set<string>();
        const out = arr.filter((k): k is string => typeof k === 'string' && byKey.has(k) && !seen.has(k) && (seen.add(k), true));
        // Append any vibes added since the saved order.
        for (const v of SLICE_VIBES) if (!seen.has(v.key)) out.push(v.key);
        return out;
      }
    }
  } catch { /* ignore */ }
  return SLICE_VIBES.map(v => v.key);
}

function saveOrder(order: string[]): void {
  try { localStorage.setItem(ORDER_KEY, JSON.stringify(order)); } catch { /* ignore */ }
}

export function VibeRow({ sliceColors, onApplyVibe, onReorderActiveChange }: {
  sliceColors: string[];
  onApplyVibe: (vibe: SliceVibe) => void;
  // Fired true on grab / false on release so the host can lock the sheet drag
  // (an off-axis reorder gesture would otherwise pull the sheet down).
  onReorderActiveChange?: (active: boolean) => void;
}) {
  const onReorderActiveRef = useRef(onReorderActiveChange);
  onReorderActiveRef.current = onReorderActiveChange;
  const [order, setOrder] = useState<string[]>(loadOrder);
  const vibes = order.map(k => byKey.get(k)!).filter(Boolean);

  const [grabbedIndex, setGrabbedIndex] = useState<number | null>(null);
  const [dragOffsetX, setDragOffsetX] = useState(0);
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);
  const [isSettling, setIsSettling] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);
  const tileElsRef = useRef<(HTMLDivElement | null)[]>([]);
  const settleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const inertiaRafRef = useRef<number | null>(null);
  const rowDragCleanupRef = useRef<(() => void) | null>(null);
  const clickSuppressUntilRef = useRef(0);
  // Virtualisation window (card indices). Spacers reserve the off-window width.
  const totalRef = useRef(order.length);
  totalRef.current = order.length;
  const [win, setWin] = useState({ start: 0, end: 14 });

  const cancelInertia = useCallback(() => {
    if (inertiaRafRef.current !== null) { cancelAnimationFrame(inertiaRafRef.current); inertiaRafRef.current = null; }
  }, []);

  // Momentum glide after a flick — same recipe as the preview-tile row.
  // `velocity` is px/ms in the scrollLeft direction.
  const startInertia = useCallback((velocity: number) => {
    const row = rowRef.current;
    if (!row) return;
    cancelInertia();
    let v = velocity;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = now - last; last = now;
      row.scrollLeft += v * dt;
      v *= Math.exp(-0.004 * dt);
      if (Math.abs(v) < 0.02) { inertiaRafRef.current = null; return; }
      inertiaRafRef.current = requestAnimationFrame(tick);
    };
    inertiaRafRef.current = requestAnimationFrame(tick);
  }, [cancelInertia]);

  // Mouse click-drag to scroll the row, with momentum on release. A card's
  // long-press tears this down via rowDragCleanupRef so the row freezes for the
  // reorder. (Touch uses native overflow-x pan + its own momentum.)
  const handleRowMouseDown = useCallback((e: ReactMouseEvent) => {
    if (e.button !== 0) return;
    const row = rowRef.current;
    if (!row) return;
    cancelInertia();
    rowDragCleanupRef.current?.();
    const startX = e.clientX;
    const startLeft = row.scrollLeft;
    let didDrag = false;
    let lastX = e.clientX;
    let lastT = performance.now();
    let velocity = 0;
    const onMove = (me: MouseEvent) => {
      const dx = me.clientX - startX;
      if (!didDrag && Math.abs(dx) > 4) didDrag = true;
      if (!didDrag) return;
      const now = performance.now();
      const dt = now - lastT;
      if (dt > 0) velocity = velocity * 0.3 + (-(me.clientX - lastX) / dt) * 0.7;
      lastX = me.clientX; lastT = now;
      row.scrollLeft = startLeft - dx;
    };
    const cleanup = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      rowDragCleanupRef.current = null;
    };
    const onUp = () => {
      cleanup();
      if (didDrag) {
        clickSuppressUntilRef.current = Date.now() + 150;
        if (performance.now() - lastT < 80 && Math.abs(velocity) > 0.1) startInertia(velocity);
      }
    };
    rowDragCleanupRef.current = cleanup;
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [cancelInertia, startInertia]);

  // Desktop: vertical wheel scrolls the row horizontally (and kills momentum).
  useEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { cancelInertia(); el.scrollLeft += e.deltaY; e.preventDefault(); }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [cancelInertia]);

  // ── Virtualisation window ──────────────────────────────────────────
  const recomputeWindow = useCallback(() => {
    const el = rowRef.current;
    const total = totalRef.current;
    if (!el) {
      setWin(prev => (prev.start === 0 && prev.end === total - 1 ? prev : { start: 0, end: Math.max(0, total - 1) }));
      return;
    }
    const start = Math.max(0, Math.floor(el.scrollLeft / SLOT_WIDTH) - BUFFER);
    const end = Math.min(total - 1, Math.ceil((el.scrollLeft + el.clientWidth) / SLOT_WIDTH) + BUFFER);
    setWin(prev => (prev.start === start && prev.end === end ? prev : { start, end }));
  }, []);

  // Recompute on scroll (rAF-coalesced) + when the row resizes (sheet opening,
  // viewport change). A `scroll` event fires for native pan, wheel, drag-scroll,
  // and momentum alike, so one listener covers them all.
  useEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    let raf = 0;
    const schedule = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(recomputeWindow); };
    el.addEventListener('scroll', schedule, { passive: true });
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    schedule();
    return () => { cancelAnimationFrame(raf); el.removeEventListener('scroll', schedule); ro.disconnect(); };
  }, [recomputeWindow]);

  // Re-window when the vibe count changes.
  useEffect(() => {
    const raf = requestAnimationFrame(recomputeWindow);
    return () => cancelAnimationFrame(raf);
  }, [order.length, recomputeWindow]);

  // Neighbours between source and drop target slide one slot to open the gap.
  const computeSlotOffset = (i: number): number => {
    if (grabbedIndex === null || dropTargetIndex === null) return 0;
    if (i === grabbedIndex) return 0;
    if (dropTargetIndex > grabbedIndex && i > grabbedIndex && i <= dropTargetIndex) return -SLOT_WIDTH;
    if (dropTargetIndex < grabbedIndex && i >= dropTargetIndex && i < grabbedIndex) return SLOT_WIDTH;
    return 0;
  };

  const handleGrabStart = useCallback((sourceIndex: number, startX: number, startY: number) => {
    // Freeze any in-progress scroll / momentum so the row holds still to reorder.
    cancelInertia();
    rowDragCleanupRef.current?.();
    if (settleTimeoutRef.current) { clearTimeout(settleTimeoutRef.current); settleTimeoutRef.current = null; }
    let currentTarget = sourceIndex;
    setGrabbedIndex(sourceIndex);
    setDragOffsetX(0);
    setDropTargetIndex(sourceIndex);
    onReorderActiveRef.current?.(true); // lock the sheet drag for this gesture

    const onMove = (me: PointerEvent) => {
      const dx = me.clientX - startX;
      const dy = me.clientY - startY;
      setDragOffsetX(dx);
      if (Math.hypot(dx, dy) < 10) return;
      const sourceEl = tileElsRef.current[sourceIndex];
      if (!sourceEl) return;
      const rect = sourceEl.getBoundingClientRect();
      const center = rect.left + rect.width / 2;
      const offsetSlots = Math.round((me.clientX - center) / SLOT_WIDTH);
      const target = Math.max(0, Math.min(totalRef.current - 1, sourceIndex + offsetSlots));
      if (target !== currentTarget) { currentTarget = target; setDropTargetIndex(target); }
    };

    const commit = () => {
      setOrder(prev => {
        if (currentTarget === sourceIndex) return prev;
        const next = [...prev];
        const [moved] = next.splice(sourceIndex, 1);
        next.splice(currentTarget, 0, moved);
        saveOrder(next);
        return next;
      });
      setGrabbedIndex(null);
      setDragOffsetX(0);
      setDropTargetIndex(null);
      setIsSettling(false);
    };

    const release = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      onReorderActiveRef.current?.(false); // finger up — sheet drag can resume
      if (currentTarget !== sourceIndex) {
        // Phase 1: glide to the drop slot; Phase 2: commit the reorder.
        setIsSettling(true);
        setDragOffsetX((currentTarget - sourceIndex) * SLOT_WIDTH);
        settleTimeoutRef.current = setTimeout(() => {
          settleTimeoutRef.current = null;
          setIsCommitting(true);
          commit();
          requestAnimationFrame(() => setIsCommitting(false));
        }, 220);
      } else {
        commit();
      }
    };
    const onUp = () => release();

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, [cancelInertia]);

  return (
    <div
      ref={rowRef}
      className="no-scrollbar"
      // Mouse drag-to-scroll with momentum (touch uses native pan). A 300ms hold
      // on a card hands off to reorder, which tears this drag down.
      onMouseDown={handleRowMouseDown}
      style={{
        display: 'flex',
        // No flex `gap` — each card owns its trailing GAP (marginRight) so the
        // spacer widths are exact multiples of SLOT_WIDTH.
        // Lock horizontal scroll while a card is grabbed so native pan doesn't
        // fight the reorder. Padding clears the grabbed card's scale + the halo
        // ring (esp. the first card); the negative margin pulls the row back out
        // to the pane edges so cards still start flush.
        overflowX: grabbedIndex !== null ? 'hidden' : 'auto',
        touchAction: grabbedIndex !== null ? 'none' : 'pan-x',
        padding: '14px 16px 16px',
        margin: '0 -16px',
        cursor: grabbedIndex !== null ? undefined : 'grab',
      }}
    >
      {/* Left spacer reserves the scrolled-past cards. */}
      {win.start > 0 && <div style={{ width: win.start * SLOT_WIDTH, flexShrink: 0 }} />}
      {vibes.slice(win.start, win.end + 1).map((vibe, j) => {
        const i = win.start + j;
        const isGrabbedSlot = grabbedIndex === i;
        return (
          <VibeCard
            key={vibe.key}
            vibe={vibe}
            index={i}
            grabbed={isGrabbedSlot && !isSettling}
            offsetX={isGrabbedSlot ? dragOffsetX : computeSlotOffset(i)}
            instant={isCommitting}
            active={isVibeActive(vibe, sliceColors)}
            innerRef={el => { tileElsRef.current[i] = el; }}
            onApply={() => onApplyVibe(vibe)}
            onGrabStart={handleGrabStart}
            shouldSuppressClick={() => Date.now() < clickSuppressUntilRef.current}
          />
        );
      })}
      {/* Right spacer reserves the not-yet-reached cards. */}
      {win.end < vibes.length - 1 && <div style={{ width: (vibes.length - 1 - win.end) * SLOT_WIDTH, flexShrink: 0 }} />}
    </div>
  );
}

function VibeCard({ vibe, index, grabbed, offsetX, instant, active, onApply, onGrabStart, shouldSuppressClick, innerRef }: {
  vibe: SliceVibe;
  index: number;
  grabbed: boolean;
  offsetX: number;
  instant: boolean;
  active: boolean;
  onApply: () => void;
  onGrabStart: (index: number, startX: number, startY: number) => void;
  shouldSuppressClick: () => boolean;
  innerRef: (el: HTMLDivElement | null) => void;
}) {
  const cuts = vibePreview(vibe);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startPos = useRef<{ x: number; y: number } | null>(null);
  const didLongPress = useRef(false);
  const didMove = useRef(false);

  const [pressed, setPressed] = useState(false);
  const clearTimer = () => { if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; } };
  const release = () => { clearTimer(); setPressed(false); };

  return (
    // Outer wrapper holds the measured ref + layout slot and does NOT transform,
    // so the drop hit-test reads the card's NATURAL centre (the inner div is what
    // lifts / translates). Measuring the transformed node kept offsetSlots at 0.
    <div ref={innerRef} style={{ width: CARD_W, flexShrink: 0, marginRight: GAP }}>
    <div
      onPointerDown={e => {
        if (e.button === 2) return;
        didLongPress.current = false;
        didMove.current = false;
        setPressed(true);
        startPos.current = { x: e.clientX, y: e.clientY };
        clearTimer();
        longPressTimer.current = setTimeout(() => {
          longPressTimer.current = null;
          didLongPress.current = true;
          setPressed(false); // hand off to the lift/scale grab visual
          const s = startPos.current;
          onGrabStart(index, s?.x ?? e.clientX, s?.y ?? e.clientY);
        }, 300);
      }}
      onPointerMove={e => {
        if (!startPos.current) return;
        if (Math.hypot(e.clientX - startPos.current.x, e.clientY - startPos.current.y) > 8) {
          didMove.current = true;
          release();
        }
      }}
      onPointerUp={release}
      onPointerLeave={release}
      onPointerCancel={release}
      onClick={() => {
        if (didLongPress.current || didMove.current || shouldSuppressClick()) { didLongPress.current = false; didMove.current = false; return; }
        onApply();
      }}
      style={{
        cursor: 'pointer',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        WebkitTouchCallout: 'none',
        touchAction: grabbed ? 'none' : 'manipulation',
        zIndex: grabbed ? 2 : undefined,
        position: 'relative',
        transition: (grabbed || instant)
          ? 'transform 0s, box-shadow 0.12s ease'
          : 'transform 0.22s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.12s ease',
        transform: `translateX(${offsetX}px) scale(${grabbed ? 1.06 : 1})`,
        filter: grabbed ? 'drop-shadow(0 8px 16px rgba(0,0,0,0.35))' : undefined,
      }}
    >
      {/* 3D card — exactly a closed slice card, but each layer is divided into
          colour cuts: top = original colours, bottom (the peek) = darkened. */}
      <div style={{ position: 'relative', height: FACE_H + PEEK }}>
        {/* Halo ring — hugs the lower layer; turns white when selected. */}
        <div style={{
          position: 'absolute', left: 0, right: 0, top: PEEK, bottom: 0, borderRadius: RADIUS,
          boxShadow: active ? HALO_ACTIVE : HALO_REST, pointerEvents: 'none',
        }} />
        {/* Bottom face — darkened colour cuts. */}
        <div style={{
          position: 'absolute', left: 0, right: 0, top: PEEK, bottom: 0, borderRadius: RADIUS,
          overflow: 'hidden', display: 'flex',
        }}>
          {cuts.map((c, i) => <span key={i} style={{ flex: 1, background: deriveCardSurfaces(c).bottom }} />)}
        </div>
        {/* Top face — original colour cuts. On tap it slides DOWN onto the peek
            and lights up, like a PushDownButton press. */}
        <div style={{
          position: 'absolute', left: 0, right: 0, top: 0, height: FACE_H, borderRadius: RADIUS,
          overflow: 'hidden', display: 'flex',
          transform: pressed ? `translateY(${PRESS_DROP}px)` : 'translateY(0)',
          filter: pressed ? 'brightness(1.12)' : undefined,
          transition: 'transform 0.1s ease, filter 0.1s ease',
        }}>
          {cuts.map((c, i) => <span key={i} style={{ flex: 1, background: c }} />)}
          {/* Pure-white inner stroke, painted OVER the cuts (an inset shadow on
              the div behind the spans is hidden by their opaque fills). */}
          <div style={{
            position: 'absolute', inset: 0, borderRadius: RADIUS, pointerEvents: 'none',
            boxShadow: 'inset 0 0 0 3px rgba(255, 255, 255, 0.15)',
          }} />
        </div>
      </div>
    </div>
    </div>
  );
}
