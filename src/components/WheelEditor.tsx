import { useState, useCallback, useRef, useEffect, useLayoutEffect } from 'react';
import { WheelConfig, WheelItem } from '../models/types';
import { InsetTextField, PushDownButton } from './PushDownButton';
import { deriveCardSurfaces, withAlpha, colorToHex, hexStringToColor, oklchShadow, oklchHighlight } from '../utils/colorUtils';
import { HexColorPicker } from 'react-colorful';
import { SEGMENT_COLORS, ON_SURFACE, BORDER, PRIMARY, BG, SURFACE_ELEVATED } from '../utils/constants';
import {
  GripVertical, ChevronDown, Plus, Minus, Palette, Image, Trash2,
  Copy, CheckCircle, Circle, Settings,
} from 'lucide-react';
import SwipeableActionCell from './SwipeableActionCell';
import { HistoryControls } from '../hooks/useHistory';

interface SegmentData {
  id: string;
  text: string;
  color: string;
  weight: number;
  imagePath?: string | null;
  iconName?: string | null;
}

export interface EditorState {
  segments: SegmentData[];
  name: string;
  textSize: number;
  headerTextSize: number;
  imageSize: number;
  cornerRadius: number;
  strokeWidth: number;
  showBackgroundCircle: boolean;
  centerMarkerSize: number;
  innerCornerStyle: 'none' | 'rounded' | 'circular' | 'straight';
  centerInset: number;
  segmentsMode: 'list' | 'cards';
}

interface WheelEditorProps {
  initialConfig?: WheelConfig | null;
  history: HistoryControls<EditorState>;
  onPreview?: (config: WheelConfig) => void;
  onClose?: () => void;
  // Optional controlled tab. If provided, the editor renders that tab and
  // calls onTabChange when the user taps a tab header. If omitted, the
  // editor manages its own tab state (legacy behavior).
  selectedTab?: number;
  onTabChange?: (tab: number) => void;
  // Fires when a segment-reorder gesture activates / releases. Lets the
  // hosting screen lock parent gestures (e.g. the SnappingSheet's
  // scroll-to-drag handoff) so the sheet doesn't slide while a card is
  // being dragged.
  onReorderActiveChange?: (active: boolean) => void;
  // When non-null, the editor scrolls the segment list to that index on
  // mount / prop change, then calls onScrollToSegmentConsumed so the
  // host can clear it. Used by the wheel canvas's long-press → open
  // sheet → scroll-to-segment flow.
  scrollToSegmentIndex?: number | null;
  onScrollToSegmentConsumed?: () => void;
}

let segmentIdCounter = 0;

// Pick the palette colour that comes *next after* the last segment's
// colour in SEGMENT_COLORS, so successive add-segment clicks walk through
// the palette in order even when earlier segments have been recoloured /
// reordered. Falls back to a count-based pick when the wheel is empty or
// the last segment uses a custom (non-palette) colour.
function getNextColor(segments: SegmentData[]): string {
  if (segments.length === 0) return SEGMENT_COLORS[0];
  const lastColor = segments[segments.length - 1].color;
  const lastIdx = SEGMENT_COLORS.indexOf(lastColor);
  if (lastIdx === -1) {
    return SEGMENT_COLORS[segments.length % SEGMENT_COLORS.length];
  }
  return SEGMENT_COLORS[(lastIdx + 1) % SEGMENT_COLORS.length];
}

export function buildInitialState(config?: WheelConfig | null): EditorState {
  const segments: SegmentData[] = config
    ? config.items.map(item => ({
        id: `${segmentIdCounter++}`,
        text: item.text,
        color: item.color,
        weight: item.weight,
        imagePath: item.imagePath,
        iconName: item.iconName,
      }))
    : [
        { id: `${segmentIdCounter++}`, text: 'Option 1', color: SEGMENT_COLORS[9], weight: 1 },
        { id: `${segmentIdCounter++}`, text: 'Option 2', color: SEGMENT_COLORS[0], weight: 1 },
      ];

  return {
    segments,
    name: config?.name ?? 'New Wheel',
    textSize: config?.textSize ?? 1,
    headerTextSize: config?.headerTextSize ?? 1,
    imageSize: config?.imageSize ?? 60,
    cornerRadius: config?.cornerRadius ?? 30,
    strokeWidth: config?.strokeWidth ?? 7.7,
    showBackgroundCircle: config?.showBackgroundCircle ?? true,
    centerMarkerSize: config?.centerMarkerSize ?? 250,
    innerCornerStyle: config?.innerCornerStyle ?? 'none',
    centerInset: config?.centerInset ?? 50,
    // Migrate the legacy 'simple'/'complex' values from older saved wheels
    // into the new 'list'/'cards' vocabulary. New wheels default to
    // 'cards' (the more expressive editor).
    segmentsMode: ((config?.segmentsMode as unknown) === 'simple' ? 'list'
      : (config?.segmentsMode as unknown) === 'complex' ? 'cards'
      : config?.segmentsMode ?? 'cards'),
  };
}

export function stateToConfig(state: EditorState, id: string): WheelConfig {
  return {
    id,
    name: state.name.trim(),
    items: state.segments.map(seg => ({
      text: seg.text,
      color: seg.color,
      weight: seg.weight,
      imagePath: seg.imagePath,
      iconName: seg.iconName,
    })),
    textSize: state.textSize,
    headerTextSize: state.headerTextSize,
    imageSize: state.imageSize,
    cornerRadius: state.cornerRadius,
    imageCornerRadius: state.cornerRadius,
    strokeWidth: state.strokeWidth,
    showBackgroundCircle: state.showBackgroundCircle,
    centerMarkerSize: state.centerMarkerSize,
    innerCornerStyle: state.innerCornerStyle,
    centerInset: state.centerInset,
    segmentsMode: state.segmentsMode,
  };
}

export default function WheelEditor({
  initialConfig, history, onPreview, onClose,
  selectedTab: selectedTabProp, onTabChange, onReorderActiveChange,
  scrollToSegmentIndex, onScrollToSegmentConsumed,
}: WheelEditorProps) {
  const configId = initialConfig?.id ?? Date.now().toString();
  const { state, set, patch, commit, undo, redo } = history;
  const { segments, name } = state;

  // UI-only state
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  // Segment id currently mid-delete animation. While set, the matching
  // SegmentRow plays a two-phase exit (card+buttons zoom to 0, then the
  // row's height collapses) before the segment is actually removed from
  // state. Keyed by id (not index) so neighbour reorders during the
  // animation don't lose the reference.
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // Tab selection is controlled by the chips in the red footer via the
  // selectedTab prop; the internal fallback stays at 0 (Segments).
  const selectedTab = selectedTabProp ?? 0;
  // Mode lives on EditorState so it persists per-wheel through the same
  // save cycle as everything else (Firestore round-trip, undo/redo).
  const segmentsMode = state.segmentsMode;
  const setSegmentsMode = (v: 'list' | 'cards') => {
    if (v !== stateRef.current.segmentsMode) {
      set({ ...stateRef.current, segmentsMode: v });
    }
  };
  const [colorPickerSegment, setColorPickerSegment] = useState<number | null>(null);

  // ── Reorder state — same two-phase release pattern as RouletteScreen's
  // preview row and BlocksList card list. The grabbed row sits in its
  // original DOM slot, follows the pointer with translateY, while
  // neighbors between source and dropTarget slide ±sourceSlotHeight to
  // open the empty drop slot. On release: phase 1 glides the grabbed row
  // to the drop slot via the same 0.22s easing as neighbors; phase 2
  // commits the array reorder atomically while `isCommitting` suppresses
  // the transform transition for one paint frame so the natural-position
  // shift doesn't re-animate on top of the now-zero translateY.
  const [grabbedIndex, setGrabbedIndex] = useState<number | null>(null);
  const [dragOffsetY, setDragOffsetY] = useState(0);
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);
  const [isSettling, setIsSettling] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);
  const dragSnapshotRef = useRef<{
    rowTops: number[];
    rowHeights: number[];
    sourceSlotHeight: number; // measured row height + outer marginBottom (SEGMENT_ROW_GAP)
  } | null>(null);
  const settleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const segmentElsRef = useRef<(HTMLDivElement | null)[]>([]);
  // Ref to the Add Segment button's wrapper — used as the scroll target so
  // tapping it keeps the BUTTON itself visible (not just the new segment,
  // which sits above it in the DOM and would still leave the button below
  // the viewport after the add).
  const addSegmentBtnRef = useRef<HTMLDivElement | null>(null);
  // Set true the moment a drag-reorder activates (either via long-press or
  // grip). The card's onClick checks this on the next click and bails so
  // the drop-release doesn't also expand the segment — drag-and-release
  // should be a pure reorder, only a clean tap toggles expand/collapse.
  const didDragRef = useRef(false);
  // Per-segment halo element refs. SwipeableActionCell calls onOffsetChange
  // with the current swipe offset; we look up the matching halo div and
  // imperatively translate it so it slides with the card. Without this the
  // halo (which lives on the outer row, outside the cell's overflow:hidden
  // clip box) would visually stay behind when the card swipes aside.
  const haloElsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const segmentsRef = useRef(segments);
  segmentsRef.current = segments;

  // Scroll the nearest scrollable ancestor of `anchorEl` to its bottom
  // over 110ms (easeOutCubic) — same curve and duration as the wheel's
  // segment-add transition (see SpinningWheel.tsx). Walks every ancestor;
  // whichever has overflow-y auto / scroll AND actually has overflow
  // content (scrollHeight > clientHeight) wins. Falls back to
  // document.scrollingElement if nothing usable is found.
  const scrollAncestorToBottom = (anchorEl: HTMLElement) => {
    let scrollEl: HTMLElement | null = null;
    let cur: HTMLElement | null = anchorEl.parentElement;
    while (cur) {
      const cs = getComputedStyle(cur);
      const overflowY = cs.overflowY;
      const overflow = cs.overflow;
      const isScrollable = /(auto|scroll)/.test(overflowY) || /(auto|scroll)/.test(overflow);
      if (isScrollable && cur.scrollHeight > cur.clientHeight + 1) {
        scrollEl = cur;
        break;
      }
      cur = cur.parentElement;
    }
    if (!scrollEl) scrollEl = (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
    if (!scrollEl) return;
    const startScroll = scrollEl.scrollTop;
    const target = scrollEl;
    const t0 = performance.now();
    // Recompute the bottom on every frame: when a segment is added the
    // scrollHeight grows AFTER React's commit (the new row's content
    // might still be settling layout for a frame or two). If we lock
    // `targetScroll` at the start, we'd undershoot. By querying
    // `scrollHeight - clientHeight` each tick, the tween's final landing
    // is whatever the bottom is at the END of the 150ms window.
    const tick = (now: number) => {
      const u = Math.min(1, (now - t0) / 110);
      const eased = 1 - Math.pow(1 - u, 3);
      const liveBottom = target.scrollHeight - target.clientHeight;
      target.scrollTop = startScroll + (liveBottom - startScroll) * eased;
      if (u < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

  // Keep a ref to current state for use in pointer handlers
  const stateRef = useRef(state);
  stateRef.current = state;

  // Scroll-to-segment request (from a wheel-canvas long-press in the
  // host). Wait one rAF after mount/prop-change so the segment row's
  // ref is populated, then find the nearest scrollable ancestor and
  // tween its scrollTop so the target row sits in view. 110ms
  // easeOutCubic — same curve as the "scroll to Add Segment" tween.
  useEffect(() => {
    if (scrollToSegmentIndex == null) return;
    const idx = scrollToSegmentIndex;
    const cancel = requestAnimationFrame(() => {
      // List mode: focus the textarea, select the matching line, and
      // explicitly scroll both the textarea's internal scroll AND its
      // nearest scrollable ancestor — the browser's setSelectionRange
      // auto-scroll isn't reliable inside nested scroll containers.
      if (stateRef.current.segmentsMode === 'list') {
        const ta = simpleTextareaRef.current;
        if (!ta) { onScrollToSegmentConsumed?.(); return; }
        const lines = ta.value.split('\n');
        const clamped = Math.max(0, Math.min(idx, lines.length - 1));
        let start = 0;
        for (let i = 0; i < clamped; i++) start += lines[i].length + 1;
        const end = start + (lines[clamped]?.length ?? 0);
        ta.focus();
        ta.setSelectionRange(start, end);

        // (a) Textarea internal scroll: position the selected line in
        // the middle of the visible textarea area.
        const cs = getComputedStyle(ta);
        const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.25 || 20;
        const linePixelY = clamped * lineHeight;
        ta.scrollTop = Math.max(0, linePixelY - ta.clientHeight / 2 + lineHeight / 2);

        // (b) Ancestor sheet-content scroll: tween so the textarea (or
        // at least the selected line within it) is in view inside the
        // sheet. Same 110ms easeOutCubic as the cards-mode path.
        let scrollEl: HTMLElement | null = ta.parentElement;
        while (scrollEl) {
          const csA = getComputedStyle(scrollEl);
          if ((/(auto|scroll)/.test(csA.overflowY) || /(auto|scroll)/.test(csA.overflow))
              && scrollEl.scrollHeight > scrollEl.clientHeight + 1) break;
          scrollEl = scrollEl.parentElement;
        }
        if (scrollEl) {
          const taRect = ta.getBoundingClientRect();
          const scRect = scrollEl.getBoundingClientRect();
          const lineYWithinTa = clamped * lineHeight - ta.scrollTop;
          // Aim to centre the selected line inside the scroll viewport.
          const desiredTop = (taRect.top + lineYWithinTa) - scRect.top - scRect.height / 2 + lineHeight / 2;
          const startScroll = scrollEl.scrollTop;
          const maxScroll = scrollEl.scrollHeight - scrollEl.clientHeight;
          const targetScroll = Math.max(0, Math.min(maxScroll, startScroll + desiredTop));
          const delta = targetScroll - startScroll;
          const target = scrollEl;
          const t0 = performance.now();
          const tick = (now: number) => {
            const u = Math.min(1, (now - t0) / 110);
            const eased = 1 - Math.pow(1 - u, 3);
            target.scrollTop = startScroll + delta * eased;
            if (u < 1) requestAnimationFrame(tick);
            else onScrollToSegmentConsumed?.();
          };
          requestAnimationFrame(tick);
        } else {
          onScrollToSegmentConsumed?.();
        }
        return;
      }
      const el = segmentElsRef.current[idx];
      if (!el) { onScrollToSegmentConsumed?.(); return; }
      let scrollEl: HTMLElement | null = el.parentElement;
      while (scrollEl) {
        const cs = getComputedStyle(scrollEl);
        if (/(auto|scroll)/.test(cs.overflowY) || /(auto|scroll)/.test(cs.overflow)) {
          if (scrollEl.scrollHeight > scrollEl.clientHeight + 1) break;
        }
        scrollEl = scrollEl.parentElement;
      }
      if (!scrollEl) { onScrollToSegmentConsumed?.(); return; }
      const elRect = el.getBoundingClientRect();
      const scRect = scrollEl.getBoundingClientRect();
      // Centre the row in the scroll viewport (or as close as the
      // scrollable extent allows).
      const targetCentre = elRect.top + elRect.height / 2 - scRect.top - scRect.height / 2;
      const startScroll = scrollEl.scrollTop;
      const maxScroll = scrollEl.scrollHeight - scrollEl.clientHeight;
      const targetScroll = Math.max(0, Math.min(maxScroll, startScroll + targetCentre));
      const delta = targetScroll - startScroll;
      const target = scrollEl;
      const t0 = performance.now();
      const tick = (now: number) => {
        const u = Math.min(1, (now - t0) / 110);
        const eased = 1 - Math.pow(1 - u, 3);
        target.scrollTop = startScroll + delta * eased;
        if (u < 1) requestAnimationFrame(tick);
        else onScrollToSegmentConsumed?.();
      };
      requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(cancel);
  }, [scrollToSegmentIndex, onScrollToSegmentConsumed]);

  // Push the current state out as a config preview on every change. Mount
  // fires it once (initial state). Subsequent state changes — style
  // sliders, name edits, anything else patched via history — also fire
  // it. Previously only segment changes (via sendPreview in
  // commitWithAnim) reached the parent; style changes never did, so the
  // App-level block never received the update and profile thumbnails
  // stayed stale until something else (item edit, sheet close) forced a
  // save. handleWheelPreview in the parent already debounces 500ms.
  useEffect(() => {
    if (!onPreview || !state.name.trim()) return;
    onPreview(stateToConfig(state, configId));
  }, [state, onPreview, configId]);

  // Lock the parent scroll container while a row is being dragged. Same
  // recipe as BlocksList — walks up to find every scrollable ancestor,
  // sets overflow:hidden + touch-action:none, restores on release.
  useEffect(() => {
    if (grabbedIndex === null) return;
    const el = segmentElsRef.current[grabbedIndex];
    if (!el) return;
    const frozen: { el: HTMLElement; prevOverflow: string; prevTouchAction: string }[] = [];
    let cur: HTMLElement | null = el.parentElement;
    while (cur) {
      const cs = getComputedStyle(cur);
      if (/(auto|scroll)/.test(cs.overflowY) || /(auto|scroll)/.test(cs.overflowX)) {
        frozen.push({
          el: cur,
          prevOverflow: cur.style.overflow,
          prevTouchAction: cur.style.touchAction,
        });
        cur.style.overflow = 'hidden';
        cur.style.touchAction = 'none';
      }
      cur = cur.parentElement;
    }
    return () => {
      frozen.forEach(({ el, prevOverflow, prevTouchAction }) => {
        el.style.overflow = prevOverflow;
        el.style.touchAction = prevTouchAction;
      });
    };
  }, [grabbedIndex]);

  // --- Discrete actions (push to history) ---

  // Smooth add/remove animation strategy (ported from the old Flutter app):
  // the SpinningWheel cross-fades segment weights/colors only when item
  // *count* stays constant. So we do a two-step dance:
  //   ADD-shaped commit: paint #1 = N+1 segments with the *added* one at
  //     near-zero weight (snap, but the new sliver is invisible — the
  //     painter skips drawing wedges below an arc threshold so it never
  //     pops a stroke). paint #2 = same N+1 segments with full weight.
  //     Same count → wheel animates the slice growing in.
  //   REMOVE-shaped commit: paint #1 = same N segments with the *removed*
  //     one's weight forced to near-zero. Same count → wheel animates the
  //     slice shrinking out. After 110ms: paint #2 = N-1 segments. Snap,
  //     but the removed slice was already invisible so the jump is gone.
  // setTimeout(0) between the two paints lets React commit + the browser
  // paint the intermediate state before the second update lands. Without
  // it React 18 auto-batching collapses both into one render and the
  // SpinningWheel never sees the same-count transition.
  const sendPreview = (segs: SegmentData[]) => {
    if (!onPreview) return;
    if (!stateRef.current.name.trim()) return;
    onPreview(stateToConfig({ ...stateRef.current, segments: segs }, configId));
  };

  // Generic helper: commit a new segment list, animating any added or
  // removed segment via the near-zero-weight dance. No-op transition for
  // pure edits (same length) — those just commit.
  const commitWithAnim = (newSegs: SegmentData[]) => {
    const prev = stateRef.current.segments;
    const prevIds = new Set(prev.map(s => s.id));
    const newIds = new Set(newSegs.map(s => s.id));

    if (newSegs.length === prev.length + 1) {
      const addedId = newSegs.find(s => !prevIds.has(s.id))?.id;
      if (addedId) {
        sendPreview(newSegs.map(s => s.id === addedId ? { ...s, weight: 0.001 } : s));
        setTimeout(() => set({ ...stateRef.current, segments: newSegs }), 0);
        return;
      }
    } else if (newSegs.length === prev.length - 1) {
      const removedId = prev.find(s => !newIds.has(s.id))?.id;
      if (removedId) {
        sendPreview(prev.map(s => s.id === removedId ? { ...s, weight: 0.001 } : s));
        setTimeout(() => set({ ...stateRef.current, segments: newSegs }), 110);
        return;
      }
    }

    // Length unchanged or multi-segment delta → just commit; SpinningWheel
    // will cross-fade weights / colors automatically when same-count.
    set({ ...stateRef.current, segments: newSegs });
  };

  const addSegment = () => {
    const id = `${segmentIdCounter++}`;
    const newSegment: SegmentData = {
      id,
      text: `Option ${stateRef.current.segments.length + 1}`,
      color: getNextColor(stateRef.current.segments),
      weight: 1,
    };
    // Close any open segment so the freshly-added one (and the scroll
    // landing on the Add button) aren't fighting an in-flight expand.
    setExpandedIndex(null);
    commitWithAnim([...stateRef.current.segments, newSegment]);
    // commitWithAnim defers state-update via setTimeout(0). Chain another
    // setTimeout + rAF to land after React's render commits, then scroll
    // the page to the bottom — keeps both the new segment and the Add
    // Segment button visible in the same gesture.
    setTimeout(() => requestAnimationFrame(() => {
      if (addSegmentBtnRef.current) scrollAncestorToBottom(addSegmentBtnRef.current);
    }), 0);
  };

  const removeSegment = (index: number) => {
    // No floor — let the user delete down to 0. Wheel paint handles
    // empty / single-segment cases gracefully.
    setExpandedIndex(null);
    const segment = stateRef.current.segments[index];
    if (!segment) return;
    // Kick the wheel's segment-shrink preview off IMMEDIATELY so the
    // wheel animates in parallel with the card's exit (instead of
    // sequentially after, which is what commitWithAnim would do if
    // called at the end of the timeout).
    const prev = stateRef.current.segments;
    sendPreview(prev.map(s => s.id === segment.id ? { ...s, weight: 0.001 } : s));
    // Two-phase card delete: SegmentRow plays scale-down (180ms) +
    // height-collapse (180ms) once its `isDeleting` prop flips. After
    // the animation timeline we commit the actual filter — `set`
    // directly (not commitWithAnim) because the wheel already has the
    // shrunk preview in flight; running commitWithAnim's length-1
    // branch here would re-fire the same preview and the wheel would
    // double-animate.
    setDeletingId(segment.id);
    setTimeout(() => {
      setDeletingId(null);
      set({ ...stateRef.current, segments: stateRef.current.segments.filter(s => s.id !== segment.id) });
    }, 360);
  };

  const duplicateSegment = (index: number) => {
    const original = stateRef.current.segments[index];
    const id = `${segmentIdCounter++}`;
    const newSegs = [...stateRef.current.segments];
    newSegs.splice(index + 1, 0, { ...original, id });
    // Close any open segment so the freshly-inserted duplicate doesn't
    // fight an in-flight expand on the source row.
    setExpandedIndex(null);
    commitWithAnim(newSegs);
  };

  // --- Continuous actions (patch, commit on end) ---

  const patchSegment = (index: number, updates: Partial<SegmentData>) => {
    const newSegs = state.segments.map((s, i) => i === index ? { ...s, ...updates } : s);
    patch({ segments: newSegs });
  };

  // --- Drag reorder (two-phase release) ---

  // Marker for code that needs to read `patch`/`commit` if anyone reaches in
  // — currently the reorder uses `set` for a single discrete history push
  // on phase-2 commit, but kept here so an inline patch path can be added
  // back without re-threading the dependency tree.
  void patch; void commit;

  // The 8px inter-row gap now lives on the SegmentRow's outer marginBottom
  // (mirroring BlockRow in BlocksList). Margin is OUTSIDE the row's box,
  // so getBoundingClientRect.height excludes it — slot-shift math adds
  // the gap to compute neighbor displacement.
  const SEGMENT_ROW_GAP = 9;

  // Slot-shift offset for a non-grabbed row at index `i` while the user
  // is dragging the row at `grabbedIndex` toward `dropTargetIndex`.
  const computeSlotOffset = (i: number): number => {
    if (grabbedIndex === null || dropTargetIndex === null) return 0;
    if (i === grabbedIndex) return 0;
    const slot = dragSnapshotRef.current?.sourceSlotHeight ?? 0;
    if (dropTargetIndex > grabbedIndex) {
      if (i > grabbedIndex && i <= dropTargetIndex) return -slot;
    } else if (dropTargetIndex < grabbedIndex) {
      if (i >= dropTargetIndex && i < grabbedIndex) return slot;
    }
    return 0;
  };

  const handleGrabStart = useCallback((sourceIndex: number, startX: number, startY: number) => {
    if (settleTimeoutRef.current) {
      clearTimeout(settleTimeoutRef.current);
      settleTimeoutRef.current = null;
    }
    // Mark this gesture as a drag — the card's onClick will see the flag
    // on the post-release click and skip the expand toggle.
    didDragRef.current = true;
    // Synchronous notify — host (e.g. SnappingSheet's parent) can flip a
    // ref / state immediately so its pointer handlers see the locked
    // value on the very next pointermove. Doing this via useEffect would
    // delay the signal by one commit and let the sheet drag a few px
    // under the user's finger before the lock engaged.
    onReorderActiveChange?.(true);

    const rowTops: number[] = [];
    const rowHeights: number[] = [];
    segmentElsRef.current.forEach(el => {
      if (el) {
        const r = el.getBoundingClientRect();
        rowTops.push(r.top);
        rowHeights.push(r.height);
      } else {
        rowTops.push(0);
        rowHeights.push(0);
      }
    });
    const sourceSlotHeight = (rowHeights[sourceIndex] ?? 0) + SEGMENT_ROW_GAP;
    dragSnapshotRef.current = { rowTops, rowHeights, sourceSlotHeight };

    let currentTarget = sourceIndex;
    setGrabbedIndex(sourceIndex);
    setDragOffsetY(0);
    setDropTargetIndex(sourceIndex);
    // Collapse the card on grab — its expanded controls would otherwise
    // jitter the slot-shift math and aren't relevant during drag.
    setExpandedIndex(null);

    const onMove = (me: PointerEvent) => {
      const dx = me.clientX - startX;
      const dy = me.clientY - startY;
      setDragOffsetY(dy);
      // 10px threshold before shifting neighbors — same as PreviewTile,
      // avoids twitchy slot indicators on sub-pixel jitter at start.
      if (Math.hypot(dx, dy) < 10) return;

      const snap = dragSnapshotRef.current!;
      let target = snap.rowTops.length - 1;
      for (let i = 0; i < snap.rowTops.length; i++) {
        const mid = snap.rowTops[i] + snap.rowHeights[i] / 2;
        if (me.clientY < mid) {
          target = i;
          break;
        }
      }
      target = Math.max(0, Math.min(target, segmentsRef.current.length - 1));
      if (target === currentTarget) return;
      currentTarget = target;
      setDropTargetIndex(target);
    };

    const cleanup = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };

    const finishRelease = (commitNow: boolean) => {
      if (commitNow && currentTarget !== sourceIndex) {
        const next = [...segmentsRef.current];
        const [moved] = next.splice(sourceIndex, 1);
        next.splice(currentTarget, 0, moved);
        // Single discrete history push — no live patch during drag.
        set({ ...stateRef.current, segments: next });
      }
      setGrabbedIndex(null);
      setDragOffsetY(0);
      setDropTargetIndex(null);
      setIsSettling(false);
      dragSnapshotRef.current = null;
      onReorderActiveChange?.(false);
    };

    const releaseToTarget = () => {
      const snap = dragSnapshotRef.current!;
      const sourceTop = snap.rowTops[sourceIndex];
      const finalOffset = currentTarget > sourceIndex
        ? snap.rowTops[currentTarget] + snap.rowHeights[currentTarget] - snap.rowHeights[sourceIndex] - sourceTop
        : snap.rowTops[currentTarget] - sourceTop;
      setIsSettling(true);
      setDragOffsetY(finalOffset);
      settleTimeoutRef.current = setTimeout(() => {
        settleTimeoutRef.current = null;
        setIsCommitting(true);
        finishRelease(true);
        requestAnimationFrame(() => setIsCommitting(false));
      }, 220);
    };

    const onUp = () => {
      cleanup();
      if (currentTarget !== sourceIndex) releaseToTarget();
      else finishRelease(false);
    };
    const onCancel = () => {
      cleanup();
      if (currentTarget !== sourceIndex) releaseToTarget();
      else finishRelease(false);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  }, [set, onReorderActiveChange]);

  // Direct grab on the GripVertical icon — kept as a separate fast path
  // alongside the long-press-anywhere path. 8px vertical movement before
  // activation distinguishes a drag from a tap-to-toggle (which falls
  // through to the row's onClick to expand/collapse).
  const handleGripPointerDown = useCallback((sourceIndex: number, e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    let activated = false;

    const onMove = (me: PointerEvent) => {
      if (activated) return;
      const dx = me.clientX - startX;
      const dy = me.clientY - startY;
      if (Math.abs(dy) > 8) {
        activated = true;
        cleanup();
        // Hand off to the shared handleGrabStart, which attaches its own
        // window listeners and runs the snapshot + slot-shift + release.
        handleGrabStart(sourceIndex, startX, startY);
      } else if (Math.abs(dx) > 8) {
        cleanup();
      }
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    const onUp = () => {
      cleanup();
      // No drag activated — let the click event bubble to the row's
      // onClick (toggle expand/collapse).
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, [handleGrabStart]);

  // --- Keyboard shortcut ---
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
          redo();
        } else {
          undo();
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [undo, redo]);

  // Render segment card
  const renderSegmentCard = (segment: SegmentData, index: number) => {
    const isExpanded = expandedIndex === index;
    // Every layer is derived from segment.color via OKLCh ops — bottom
    // face = base darkened, inner stroke = base darkened less, halo (on
    // the outer SegmentRow) = bottom + 25% alpha. Only segment.color
    // itself is passed through verbatim. Expanded state swaps the top
    // face to SURFACE for contrast against the controls; bottom face +
    // inner stroke + halo still derive from segment.color so the card's
    // colour identity is preserved.
    const surfaces = deriveCardSurfaces(segment.color);
    const bgColor = isExpanded ? '#FFFFFF' : surfaces.top;
    const borderColor = surfaces.innerStroke;
    const bottomColor = surfaces.bottom;
    const textColor = isExpanded ? '#1E1E2C' : '#FFFFFF';

    const card = (
      // paddingBottom: 6.5 reserves room inside the SwipeableActionCell's
      // overflow:hidden clip box for the bottom face peek. The halo ring
      // and drop shadow live on the outer SegmentRow (mirroring BlockRow
      // in BlocksList), so no horizontal padding is needed here — the
      // halo extends past the SwipeableActionCell entirely.
      <div key={segment.id} style={{ paddingBottom: 6.5 }}>
        {/* 3D Card */}
        <div style={{ position: 'relative' }}>
          {/* Bottom face — solid color only; the halo ring lives on the
              SegmentRow's outer boxShadow. */}
          <div style={{
            position: 'absolute',
            left: 0, right: 0, top: 6.5, bottom: -6.5,
            borderRadius: 21,
            backgroundColor: bottomColor,
          }} />
          {/* Top face — 3px inner stroke (matches the BlocksList recipe;
              uses a darker shade of the segment color so colored cards
              still feel coherent). */}
          <div style={{
            position: 'relative',
            borderRadius: 21,
            backgroundColor: bgColor,
            border: `3px solid ${borderColor}`,
            overflow: 'hidden',
          }}>
            {/* Collapsed row — minHeight matches the profile card's top
                face height (3px border + 12px padding + 44px thumbnail +
                12px padding = ~71px outer; the inner content area target
                is ~65px). Keeps both surfaces visually consistent so the
                two list types feel like the same component at different
                call sites. */}
            <div
              onClick={() => {
                // Drag-and-release should NOT also toggle expand. didDragRef
                // is set the moment handleGrabStart fires (either path:
                // long-press or grip). Consume the flag and bail.
                if (didDragRef.current) {
                  didDragRef.current = false;
                  return;
                }
                setExpandedIndex(isExpanded ? null : index);
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '8px 0',
                minHeight: 58,
                cursor: 'pointer',
              }}
            >
              <div
                // Asymmetric padding tucks the grip icon to the left
                // (10px left) while the right padding sets the gap
                // between grip and text — reducing this widens the
                // text input on its left side. Pair any change here
                // with an equal reduction on the chevron container's
                // right padding to keep the text centred.
                style={{ padding: '0 10px 0 10px', touchAction: 'none', cursor: isExpanded ? 'default' : 'grab' }}
                onPointerDown={isExpanded ? undefined : (e) => handleGripPointerDown(index, e)}
              >
                <div style={{
                  width: 28,
                  height: 28,
                  // Closed: stronger OKLCh-darken of the segment colour
                  // (delta 0.10 vs default 0.05) so the grip reads more
                  // clearly against the card's bright top face. Open:
                  // the existing dark-grey alpha that contrasts on the
                  // white expanded card.
                  backgroundColor: isExpanded ? withAlpha('#1E1E2C', 0.35) : oklchShadow(segment.color, 0.07),
                  WebkitMaskImage: 'url(/images/drag.svg)',
                  WebkitMaskRepeat: 'no-repeat',
                  WebkitMaskSize: 'contain',
                  WebkitMaskPosition: 'center',
                  maskImage: 'url(/images/drag.svg)',
                  maskRepeat: 'no-repeat',
                  maskSize: 'contain',
                  maskPosition: 'center',
                }} />
              </div>
              <div
                style={{ flex: 1 }}
                onClick={isExpanded ? (e) => e.stopPropagation() : undefined}
                onPointerDown={isExpanded ? (e) => e.stopPropagation() : undefined}
              >
                {/* Single text element, swaps modes — closed: transparent
                    bg/border, parent onClick handles tap-to-expand;
                    open: visible field bg/border, dark editable text.
                    Position + font stay identical between modes so the
                    text doesn't shift when the field appears, only the
                    bounds + bg fade in. */}
                <input
                  type="text"
                  value={segment.text}
                  onChange={e => patchSegment(index, { text: e.target.value })}
                  onBlur={isExpanded ? commit : undefined}
                  placeholder="Segment name"
                  readOnly={!isExpanded}
                  tabIndex={isExpanded ? 0 : -1}
                  style={{
                    display: 'block',
                    boxSizing: 'border-box',
                    width: '100%',
                    border: `2.5px solid ${isExpanded ? oklchShadow('#F8F8F9', 0.06) : 'transparent'}`,
                    borderRadius: 14,
                    outline: 'none',
                    backgroundColor: isExpanded ? '#F8F8F9' : 'transparent',
                    padding: '10px 12px',
                    fontSize: 17,
                    fontWeight: 600,
                    fontFamily: 'inherit',
                    color: isExpanded ? '#1E1E2C' : textColor,
                    // Closed = non-interactive; parent's onClick toggles expand.
                    pointerEvents: isExpanded ? 'auto' : 'none',
                    cursor: isExpanded ? 'text' : 'pointer',
                    minWidth: 0,
                  }}
                />
              </div>
              <div style={{
                padding: '0 11px 0 9px',
              }}>
                {(() => {
                  // Faux SVG stroke via 8 layered masked-div copies
                  // around a central fill copy. Each "stroke" copy is
                  // an absolutely-positioned full-size masked div
                  // offset by ±2px in the 8 cardinal/diagonal
                  // directions — together they paint a 2px outline
                  // around the chevron shape, centred symmetrically.
                  // More deterministic than drop-shadow + mask, which
                  // can render unevenly across browsers because of how
                  // filter / mask interact in the rendering pipeline.
                  //
                  // Stroke colour = `oklchShadow(segment.color)` — same
                  // OKLCh-darken the cards use for their lifted bottom
                  // face. Red card → darker red rim, blue → darker
                  // blue, etc.
                  // When the card is expanded the chevron sits on a
                  // white surface and the segment-coloured stroke
                  // would clash, so we skip the stroke layers entirely.
                  const fillColor = isExpanded ? withAlpha('#1E1E2C', 0.4) : '#FFFFFF';
                  // Light OKLCh darken — keeps the outline subtle so it
                  // doesn't overpower the chevron's white fill. Used
                  // only in the closed state (strokeOffsets is empty
                  // when expanded, so no stroke layers render).
                  const strokeColor = oklchShadow(segment.color, 0.03);
                  const maskStyle: React.CSSProperties = {
                    position: 'absolute',
                    inset: 0,
                    WebkitMaskImage: 'url(/images/chevrons.svg)',
                    WebkitMaskRepeat: 'no-repeat',
                    WebkitMaskSize: 'contain',
                    WebkitMaskPosition: 'center',
                    maskImage: 'url(/images/chevrons.svg)',
                    maskRepeat: 'no-repeat',
                    maskSize: 'contain',
                    maskPosition: 'center',
                  };
                  // 3px cardinal + 2.12px diagonal (3 / √2) → all 8
                  // strokes sit exactly 3px from the centre. Thicker
                  // outline than the previous 2px setup.
                  const strokeOffsets: [number, number][] = isExpanded ? [] : [
                    [3, 0], [-3, 0], [0, 3], [0, -3],
                    [2.12, 2.12], [-2.12, 2.12], [2.12, -2.12], [-2.12, -2.12],
                  ];
                  return (
                    <div style={{
                      position: 'relative',
                      width: 26,
                      height: 26,
                      transform: `rotate(${isExpanded ? 180 : 0}deg)`,
                      transition: 'transform 0.2s',
                    }}>
                      {strokeOffsets.map(([dx, dy], i) => (
                        <div key={i} style={{
                          ...maskStyle,
                          backgroundColor: strokeColor,
                          transform: `translate(${dx}px, ${dy}px)`,
                        }} />
                      ))}
                      <div style={{ ...maskStyle, backgroundColor: fillColor }} />
                    </div>
                  );
                })()}
              </div>
            </div>

            {/* Expanded content */}
            {isExpanded && (
              <div
                onClick={e => e.stopPropagation()}
                style={{ padding: '0 14px 14px' }}
              >
                {/* Weight controls — label left + percentage right on top,
                    [−] slider [+] row below for both granular taps and
                    rapid drag-to-set adjustments. */}
                <div style={{ marginBottom: 12 }}>
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginBottom: 8,
                  }}>
                    <span style={{ fontWeight: 700, fontSize: 14, color: '#1E1E2C' }}>
                      Weight
                    </span>
                    <span style={{ fontWeight: 700, fontSize: 14, color: '#1E1E2C' }}>
                      {(() => {
                        // Decimal granularity scales with segment count:
                        // > 21 segments → 2 decimals, > 10 → 1, else whole %.
                        const total = state.segments.reduce((s, x) => s + x.weight, 0);
                        const pct = total > 0 ? (segment.weight / total) * 100 : 0;
                        const decimals = state.segments.length > 21 ? 2 : state.segments.length > 10 ? 1 : 0;
                        return `${pct.toFixed(decimals)}%`;
                      })()}
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <PushDownButton
                      color={'#F8F8F9'}
                      innerStrokeColor={'#E5E5E5'}
                      innerStrokeWidth={4}
                      bottomBorderColor={'#B5B5B5'}
                      borderRadius={10}
                      height={44}
                      bottomBorderWidth={5}
                      repeatHold={{ delayMs: 700, intervalMs: 150, maxIntervalMs: 50, rampMs: 900 }}
                      onTap={() => {
                        const cur = stateRef.current;
                        const currentWeight = cur.segments[index]?.weight ?? 0;
                        // Already at min — bail (don't push a no-op state
                        // update that could float the value past the
                        // floor over a long repeat-hold session).
                        if (currentWeight <= 0.1) return;
                        const newSegs = cur.segments.map((s, i) =>
                          i === index ? { ...s, weight: Math.max(0.1, s.weight - 0.1) } : s
                        );
                        set({ ...cur, segments: newSegs });
                      }}
                      style={{ width: 39 }}
                    >
                      {(pressed) => (
                        <div style={{
                          width: 25,
                          height: 25,
                          backgroundColor: withAlpha(pressed ? oklchHighlight('#1E1E2C', 0.20) : '#1E1E2C', 0.5),
                          WebkitMaskImage: 'url(/images/subtractl.svg)',
                          WebkitMaskRepeat: 'no-repeat',
                          WebkitMaskSize: 'contain',
                          WebkitMaskPosition: 'center',
                          maskImage: 'url(/images/subtractl.svg)',
                          maskRepeat: 'no-repeat',
                          maskSize: 'contain',
                          maskPosition: 'center',
                          transition: 'background-color 0.1s ease',
                        }} />
                      )}
                    </PushDownButton>
                    {/* Flex slot for the slider. The input itself is
                        absolutely positioned 3.5px wider than its slot
                        on each side, so the thumb's motion range
                        extends one halo-width past the slot edges —
                        the thumb's visible edge at min/max ends up
                        where its halo would otherwise be. */}
                    <div style={{ flex: 1, position: 'relative', height: 44 }}>
                    <input
                      type="range"
                      className="segment-weight-slider"
                      min={0.1}
                      max={10}
                      step={0.1}
                      value={segment.weight}
                      onChange={e => patchSegment(index, { weight: parseFloat(e.target.value) })}
                      onPointerUp={commit}
                      onTouchEnd={commit}
                      // Block pointer events from bubbling to the SegmentRow
                      // (long-press / drag detection) and the wrapping
                      // SwipeableActionCell (horizontal swipe-to-reveal).
                      // Bubble phase so the slider handles its own drag
                      // first; capture phase would intercept before the
                      // slider saw the events.
                      onPointerDown={e => e.stopPropagation()}
                      onMouseDown={e => e.stopPropagation()}
                      onTouchStart={e => e.stopPropagation()}
                      // --thumb-shadow = peek color (drawn via the
                      // element's own background-color, clipped by
                      // border-radius). --thumb-bg = inline SVG with
                      // two stacked paths: an OUTER stroke-color shape
                      // (top face silhouette) and an INNER top-color
                      // shape inset 3px uniformly on all sides — bottom
                      // corner radius = 4 - 3 = 1 so the stroke band
                      // stays a constant 3px wide around the full top
                      // face. Matches the PushDownButtons' fully-
                      // enclosed inner stroke look.
                      style={(() => {
                        const surfaces = deriveCardSurfaces(segment.color);
                        const top = segment.color;
                        const bot = surfaces.bottom;
                        const stroke = surfaces.innerStroke;
                        const outer = 'M5 0 H13 Q18 0 18 5 V34.5 Q18 39.5 13 39.5 H5 Q0 39.5 0 34.5 V5 Q0 0 5 0 Z';
                        const inner = 'M5 3 H13 Q15 3 15 5 V34.5 Q15 36.5 13 36.5 H5 Q3 36.5 3 34.5 V5 Q3 3 5 3 Z';
                        // Center grip — two thin vertical pills with
                        // an OKLCh-darkened tint, symmetric about the
                        // top face's horizontal center, so the knob
                        // reads with a subtle "grip" indicator.
                        const pillColor = oklchShadow(top, 0.05, 1.2);
                        const pill = `<rect x='5' y='6.75' width='2.5' height='26' rx='1.25' fill='${pillColor}'/><rect x='10.5' y='6.75' width='2.5' height='26' rx='1.25' fill='${pillColor}'/>`;
                        // Bottom layer = rounded rect from y=5 to
                        // y=44.5 (5px shorter from the top, matching
                        // PushDownButton: top face spans full height,
                        // bottom face inset by the peek amount).
                        const bottomLayer = `<rect x='0' y='5' width='18' height='39.5' rx='5' fill='${bot}'/>`;
                        // Halo matches the +/- PushDownButtons exactly:
                        // fixed grey #C4C4C4 at 25% alpha (40 = 64/255),
                        // 3.5px ring around the bottom layer only — so
                        // the thumb's shadow reads neutral regardless
                        // of segment color, instead of tinting with it.
                        // SVG viewBox is 25×51.5 = visible 18×44.5 +
                        // 3.5px halo padding on all sides; inner content
                        // runs in its own 0-18 × 0-44.5 coord system
                        // via translate(3.5,3.5).
                        const halo = `<rect x='0' y='5' width='25' height='46.5' rx='8.5' fill='#B5B5B540'/>`;
                        const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 25 51.5'>${halo}<g transform='translate(3.5 3.5)'>${bottomLayer}<path d='${outer}' fill='${stroke}'/><path d='${inner}' fill='${top}'/>${pill}</g></svg>`;
                        // Track-fill percent (clamped 0–100) and base
                        // color drive the linear-gradient on the track
                        // so the filled portion picks up the segment's
                        // own color, the unfilled portion stays grey.
                        const percent = Math.max(0, Math.min(100, ((segment.weight - 0.1) / 9.9) * 100));
                        return {
                          position: 'absolute' as const,
                          left: -3.5,
                          width: 'calc(100% + 7px)',
                          height: 44,
                          ['--thumb-bg' as string]: `url("data:image/svg+xml,${encodeURIComponent(svg)}")`,
                          ['--track-fill' as string]: top,
                          ['--track-percent' as string]: `${percent}%`,
                        };
                      })()}
                    />
                    </div>
                    <PushDownButton
                      color={'#F8F8F9'}
                      innerStrokeColor={'#E5E5E5'}
                      innerStrokeWidth={4}
                      bottomBorderColor={'#B5B5B5'}
                      borderRadius={10}
                      height={44}
                      bottomBorderWidth={5}
                      repeatHold={{ delayMs: 700, intervalMs: 150, maxIntervalMs: 50, rampMs: 900 }}
                      onTap={() => {
                        const cur = stateRef.current;
                        // No upper cap on `+` — the slider's max=10 is
                        // a VISUAL ceiling only; the underlying weight
                        // is free to keep climbing past it (which then
                        // raises this segment's percentage as the rest
                        // of the wheel stays put).
                        const newSegs = cur.segments.map((s, i) =>
                          i === index ? { ...s, weight: s.weight + 0.1 } : s
                        );
                        set({ ...cur, segments: newSegs });
                      }}
                      style={{ width: 39 }}
                    >
                      {(pressed) => (
                        <div style={{
                          width: 25,
                          height: 25,
                          backgroundColor: withAlpha(pressed ? oklchHighlight('#1E1E2C', 0.20) : '#1E1E2C', 0.5),
                          WebkitMaskImage: 'url(/images/addl.svg)',
                          WebkitMaskRepeat: 'no-repeat',
                          WebkitMaskSize: 'contain',
                          WebkitMaskPosition: 'center',
                          maskImage: 'url(/images/addl.svg)',
                          maskRepeat: 'no-repeat',
                          maskSize: 'contain',
                          maskPosition: 'center',
                          transition: 'background-color 0.1s ease',
                        }} />
                      )}
                    </PushDownButton>
                  </div>
                </div>

                {/* Color + image buttons */}
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    onClick={() => setColorPickerSegment(colorPickerSegment === index ? null : index)}
                    style={{
                      flex: 1,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 8,
                      padding: '10px 16px',
                      borderRadius: 12,
                      backgroundColor: '#F8F8F9',
                      border: `1.5px solid ${withAlpha('#1E1E2C', 0.12)}`,
                      cursor: 'pointer',
                      fontSize: 14,
                      fontWeight: 600,
                      color: '#1E1E2C',
                    }}
                  >
                    <Palette size={18} color={withAlpha('#1E1E2C', 0.6)} />
                    <div style={{
                      width: 20, height: 20,
                      borderRadius: '50%',
                      backgroundColor: segment.color,
                      border: `1.5px solid ${withAlpha('#1E1E2C', 0.12)}`,
                    }} />
                  </button>
                </div>

                {/* Inline color picker */}
                {colorPickerSegment === index && (
                  <div
                    style={{ marginTop: 12 }}
                    // Block pointer events from bubbling to the SegmentRow
                    // (long-press detection / didMoveRef) and the wrapping
                    // SwipeableActionCell (horizontal swipe-to-reveal).
                    // Bubble phase (no Capture suffix) so the color picker
                    // itself handles its own pointer events first — capture
                    // phase would intercept them before the picker saw them
                    // and the saturation / hue drags would do nothing.
                    onPointerDown={e => e.stopPropagation()}
                    onMouseDown={e => e.stopPropagation()}
                    onTouchStart={e => e.stopPropagation()}
                  >
                    <HexColorPicker
                      color={segment.color}
                      onChange={c => patchSegment(index, { color: c })}
                      style={{ width: '100%' }}
                    />
                    <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                      <input
                        type="text"
                        value={colorToHex(segment.color)}
                        onChange={e => {
                          const c = hexStringToColor(e.target.value);
                          if (c) patchSegment(index, { color: c });
                        }}
                        onBlur={commit}
                        maxLength={6}
                        style={{
                          flex: 1,
                          padding: '8px 12px',
                          borderRadius: 10,
                          border: `1.5px solid ${withAlpha('#1E1E2C', 0.15)}`,
                          backgroundColor: '#F8F8F9',
                          color: '#1E1E2C',
                          fontSize: 14,
                          fontWeight: 600,
                          fontFamily: 'inherit',
                          outline: 'none',
                        }}
                      />
                      <button
                        onClick={() => { commit(); setColorPickerSegment(null); }}
                        style={{
                          padding: '8px 16px',
                          borderRadius: 10,
                          backgroundColor: PRIMARY,
                          color: '#FFFFFF',
                          border: 'none',
                          fontWeight: 700,
                          fontSize: 13,
                          cursor: 'pointer',
                        }}
                      >
                        Done
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    );

    // Wrap with swipeable actions
    return (
      <SwipeableActionCell
        key={segment.id}
        disabled={grabbedIndex === index}
        bottomPeek={6.5}
        onOffsetChange={(offset, dragging) => {
          const el = haloElsRef.current.get(segment.id);
          if (!el) return;
          el.style.transform = `translateX(${offset}px)`;
          el.style.transition = dragging
            ? 'transform 0s ease-out'
            : 'transform 0.18s cubic-bezier(0.32, 0.72, 0, 1)';
        }}
        halo={
          <div
            ref={el => {
              if (el) haloElsRef.current.set(segment.id, el);
              else haloElsRef.current.delete(segment.id);
            }}
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: 6.5,
              bottom: 0,
              borderRadius: 21,
              boxShadow: `0 0 0 3.5px rgba(0, 0, 0, 0.4)`,
              pointerEvents: 'none',
            }}
          />
        }
        trailingActions={[
          {
            color: PRIMARY,
            icon: <Copy size={26} />,
            onTap: () => duplicateSegment(index),
          },
          {
            color: '#EF4444',
            icon: <Trash2 size={26} />,
            onTap: () => removeSegment(index),
            expandOnFullSwipe: true,
          },
        ]}
      >
        {card}
      </SwipeableActionCell>
    );
  };

  // ── Simple mode — textarea, one segment per line ───────────────────────
  // Each non-empty line becomes a segment. Existing segments are matched by
  // index so color / weight / image stay intact when the user edits lines.
  const simpleModeText = segments.map(s => s.text).join('\n');
  const [simpleDraft, setSimpleDraft] = useState(simpleModeText);
  // Ref to the list-mode textarea so the scroll-to-segment flow (from a
  // wheel-canvas long-press) can focus + select the corresponding line.
  const simpleTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Sync the draft when segments change externally (undo/redo, switching
  // wheel, etc.) and we're currently in simple mode.
  useEffect(() => {
    setSimpleDraft(segments.map(s => s.text).join('\n'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segments.length, segments.map(s => s.text).join('\n')]);

  const commitSimpleDraft = (value: string) => {
    const lines = value.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const prev = stateRef.current.segments;
    const nextSegments: SegmentData[] = lines.map((text, i) => {
      const existing = prev[i];
      if (existing) {
        // Keep color / weight / image; just update text.
        return existing.text === text ? existing : { ...existing, text };
      }
      return {
        id: `${segmentIdCounter++}`,
        text,
        color: SEGMENT_COLORS[(prev.length + i) % SEGMENT_COLORS.length],
        weight: 1,
      };
    });
    // Only commit if something actually changed. Route through commitWithAnim
    // so a new line in the textarea (or a deleted line) gets the same
    // grow / shrink animation as the cards-mode add / remove buttons.
    const same = nextSegments.length === prev.length && nextSegments.every((s, i) => s === prev[i]);
    if (!same) {
      commitWithAnim(nextSegments);
    }
  };

  const renderSimpleMode = () => (
    <div>
      <textarea
        ref={simpleTextareaRef}
        value={simpleDraft}
        onChange={e => {
          setSimpleDraft(e.target.value);
          commitSimpleDraft(e.target.value);
        }}
        onBlur={() => commitSimpleDraft(simpleDraft)}
        placeholder="One segment per line..."
        rows={12}
        style={{
          width: '100%',
          padding: '14px 16px',
          borderRadius: 14,
          border: `1.5px solid ${BORDER}`,
          backgroundColor: SURFACE_ELEVATED,
          fontSize: 16,
          fontWeight: 500,
          fontFamily: 'inherit',
          color: ON_SURFACE,
          outline: 'none',
          resize: 'vertical',
          boxSizing: 'border-box',
          lineHeight: 1.5,
        }}
      />
      <p style={{ fontSize: 12, color: withAlpha(ON_SURFACE, 0.45), margin: '8px 4px 0' }}>
        One name per line. Switch to Cards to customize colors, weights, and images.
      </p>
      <div style={{ height: 24 }} />
    </div>
  );

  // Render style tab
  const renderStyleTab = () => (
    <div style={{ paddingTop: 16 }}>
      <SettingSlider label="Segment Text" value={state.textSize} min={0.05} max={1.5} step={0.05}
        onChange={v => patch({ textSize: v })} onChangeEnd={commit} />
      <SettingSlider label="Header Text" value={state.headerTextSize} min={0.05} max={2} step={0.01}
        onChange={v => patch({ headerTextSize: v })} onChangeEnd={commit} />
      <SettingSlider label="Image Size" value={state.imageSize} min={20} max={150} step={1}
        onChange={v => patch({ imageSize: v })} onChangeEnd={commit} />
      <SettingSlider label="Corner Radius" value={state.cornerRadius} min={0} max={100} step={2.5}
        onChange={v => patch({ cornerRadius: v })} onChangeEnd={commit} />

      {/* Inner corners dropdown */}
      <div style={{ display: 'flex', alignItems: 'center', padding: '4px', marginBottom: 12 }}>
        <span style={{ fontWeight: 600, fontSize: 14, color: '#71717A', width: 100 }}>Inner Corners</span>
        <div style={{ flex: 1 }} />
        <select
          value={state.innerCornerStyle}
          onChange={e => set({ ...state, innerCornerStyle: e.target.value as EditorState['innerCornerStyle'] })}
          style={{
            padding: '6px 12px',
            borderRadius: 10,
            border: `1.5px solid ${BORDER}`,
            backgroundColor: SURFACE_ELEVATED,
            color: ON_SURFACE,
            fontWeight: 600,
            fontSize: 14,
            fontFamily: 'inherit',
            outline: 'none',
            cursor: 'pointer',
          }}
        >
          <option value="none">None</option>
          <option value="circular">Circular</option>
          <option value="rounded">Rounded</option>
          <option value="straight">Straight</option>
        </select>
      </div>

      {state.innerCornerStyle !== 'none' && (
        <SettingSlider label="Center Inset" value={state.centerInset} min={0} max={150} step={1.5}
          onChange={v => patch({ centerInset: v })} onChangeEnd={commit} />
      )}

      <SettingSlider label="Stroke Width" value={state.strokeWidth} min={0} max={20} step={0.1}
        onChange={v => patch({ strokeWidth: v })} onChangeEnd={commit} />
      <SettingSlider label="Center Marker" value={state.centerMarkerSize} min={100} max={200} step={1}
        onChange={v => patch({ centerMarkerSize: v })} onChangeEnd={commit} />

      {/* Background circle toggle */}
      <div
        onClick={() => set({ ...state, showBackgroundCircle: !state.showBackgroundCircle })}
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '12px 16px',
          borderRadius: 14,
          backgroundColor: state.showBackgroundCircle ? withAlpha(PRIMARY, 0.12) : SURFACE_ELEVATED,
          border: `1.5px solid ${state.showBackgroundCircle ? PRIMARY : BORDER}`,
          cursor: 'pointer',
          marginTop: 8,
        }}
      >
        {state.showBackgroundCircle
          ? <CheckCircle size={22} color={PRIMARY} />
          : <Circle size={22} color={BORDER} />
        }
        <span style={{
          marginLeft: 12,
          fontWeight: 600,
          fontSize: 15,
          color: state.showBackgroundCircle ? ON_SURFACE : withAlpha(ON_SURFACE, 0.5),
        }}>
          Background Circle
        </span>
      </div>

      <div style={{ height: 32 }} />
    </div>
  );

  return (
    <div style={{ padding: '4px 20px 16px' }}>
      {selectedTab === 1 ? renderStyleTab() : (
        <>
          <SegmentsModeToggle value={segmentsMode} onChange={setSegmentsMode} />
          {segmentsMode === 'list' ? renderSimpleMode() : (
            <div style={{ marginLeft: -12, marginRight: -12, position: 'relative' }}>
              {/* Left-edge drag-proxy strip. Sits on top of the leftmost
                  ~56px of the segment cards stack and forwards drag
                  pointerdowns to the matching row's drag handler, so
                  the user can grab anywhere along the sheet's left
                  margin instead of needing to land on the small grip
                  icon. Disabled when any card is expanded (so the
                  expanded card's inner controls keep raw pointer
                  access). The strip itself only captures pointerdown;
                  vertical-move > 8px in handleGripPointerDown commits
                  to a drag (so taps still bubble naturally for the
                  card's onClick → toggle expand path, and short
                  intentional gestures don't accidentally grab). */}
              {expandedIndex == null && (
                <div
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    bottom: 0,
                    width: 56,
                    zIndex: 1,
                    touchAction: 'none',
                  }}
                  onPointerDown={(e) => {
                    const y = e.clientY;
                    for (let i = 0; i < segmentElsRef.current.length; i++) {
                      const el = segmentElsRef.current[i];
                      if (!el) continue;
                      const r = el.getBoundingClientRect();
                      if (y >= r.top && y <= r.bottom) {
                        handleGripPointerDown(i, e);
                        break;
                      }
                    }
                  }}
                  onClick={(e) => {
                    const y = e.clientY;
                    for (let i = 0; i < segmentElsRef.current.length; i++) {
                      const el = segmentElsRef.current[i];
                      if (!el) continue;
                      const r = el.getBoundingClientRect();
                      if (y >= r.top && y <= r.bottom) {
                        setExpandedIndex(i);
                        break;
                      }
                    }
                  }}
                />
              )}
              {segments.map((seg, i) => {
                const isGrabbed = grabbedIndex === i;
                const slotOffset = isGrabbed ? dragOffsetY : computeSlotOffset(i);
                const grabbedNotSettling = isGrabbed && !isSettling;
                // Keep `transform` in the transition list always — only
                // duration toggles. While grabbed (mid-drag) the transform
                // must follow the pointer with no easing; while settling
                // it glides at 0.22s; on the commit frame it must be
                // instant so the natural-position shift doesn't re-animate
                // on top of a now-zero translateY.
                const transition = (grabbedNotSettling || isCommitting)
                  ? 'transform 0s, box-shadow 0.12s ease'
                  : 'transform 0.22s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.12s ease';
                const transform = isGrabbed
                  ? `translateY(${slotOffset}px) scale(1.04)`
                  : `translateY(${slotOffset}px) scale(1)`;
                return (
                  <SegmentRow
                    key={seg.id}
                    innerRef={el => { segmentElsRef.current[i] = el; }}
                    index={i}
                    isGrabbed={isGrabbed}
                    transform={transform}
                    transition={transition}
                    isDeleting={deletingId === seg.id}
                    // Long-press is gated to the collapsed state — when the
                    // card is open, all the inner controls (color picker,
                    // weight buttons, text input) need raw pointer access.
                    onLongPressActivate={expandedIndex === i ? undefined : handleGrabStart}
                  >
                    {renderSegmentCard(seg, i)}
                  </SegmentRow>
                );
              })}
              <div style={{ height: 10 }} />
              <div ref={addSegmentBtnRef} style={{ padding: '0 8px' }}>
                <PushDownButton color={PRIMARY} onTap={addSegment} borderRadius={32} innerStrokeWidth={3} height={54} bottomBorderWidth={6}>
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 0,
                    color: '#FFFFFF',
                  }}>
                    <div style={{
                      width: 36,
                      height: 36,
                      backgroundColor: '#FFFFFF',
                      WebkitMaskImage: 'url(/images/addsegment.svg)',
                      WebkitMaskRepeat: 'no-repeat',
                      WebkitMaskSize: 'contain',
                      WebkitMaskPosition: 'center',
                      maskImage: 'url(/images/addsegment.svg)',
                      maskRepeat: 'no-repeat',
                      maskSize: 'contain',
                      maskPosition: 'center',
                    }} />
                    <span style={{ fontWeight: 700, fontSize: 16 }}>Add Segment</span>
                  </div>
                </PushDownButton>
              </div>
              <div style={{ height: 2 }} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Two-mode toggle pill for Segments: "List" (textarea) vs "Cards"
// (expandable per-segment cards). 'cards' is the default for new wheels.
function SegmentsModeToggle({ value, onChange }: { value: 'list' | 'cards'; onChange: (v: 'list' | 'cards') => void }) {
  return (
    <div style={{
      display: 'flex',
      backgroundColor: SURFACE_ELEVATED,
      borderRadius: 14,
      padding: 3,
      marginBottom: 14,
    }}>
      {(['cards', 'list'] as const).map(mode => {
        const isActive = value === mode;
        return (
          <button
            key={mode}
            onClick={() => onChange(mode)}
            style={{
              flex: 1,
              padding: '8px 12px',
              borderRadius: 12,
              border: 'none',
              // Active pill = light surface (ON_SURFACE), dark text (BG).
              // Inactive = transparent on the dark track, dimmed light text.
              backgroundColor: isActive ? ON_SURFACE : 'transparent',
              color: isActive ? BG : withAlpha(ON_SURFACE, 0.55),
              fontSize: 14,
              fontWeight: 700,
              fontFamily: 'inherit',
              textTransform: 'capitalize',
              cursor: 'pointer',
              boxShadow: isActive ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
              transition: 'all 0.15s',
            }}
          >
            {mode}
          </button>
        );
      })}
    </div>
  );
}

// ── Row wrapper that owns the long-press → reorder activation ────────────
// Mirrors BlockRow in BlocksList: 300ms long-press anywhere on the card,
// 8px movement during the press cancels the timer (preserving normal
// vertical scroll + horizontal swipe-to-reveal-actions paths). On fire,
// releases any pointer capture the inner SwipeableActionCell took, and
// suppresses the click that follows so the card doesn't toggle on drop.
// Long-press activation is gated by the parent passing onLongPressActivate
// (omitted when the card is currently expanded, so its inner controls get
// raw pointer access).
function SegmentRow({
  index, isGrabbed, transform, transition, isDeleting, onLongPressActivate, innerRef, children,
}: {
  index: number;
  isGrabbed: boolean;
  transform: string;
  transition: string;
  isDeleting?: boolean;
  onLongPressActivate?: (index: number, startX: number, startY: number) => void;
  innerRef?: (el: HTMLDivElement | null) => void;
  children: React.ReactNode;
}) {
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startPosRef = useRef<{ x: number; y: number } | null>(null);
  const capturedRef = useRef<{ target: Element; pointerId: number } | null>(null);
  const didLongPressRef = useRef(false);
  // Two-phase exit when `isDeleting` flips true. Phase 1 (0-180ms) — the
  // inner wrapper scales to 0 + fades; the outer row stays at full
  // height. Phase 2 (180-360ms) — outer row collapses height +
  // marginBottom to 0 so neighbours slide up. We need an explicit
  // starting height for the height transition (transitions don't run
  // from `auto`), so useLayoutEffect captures the measured height the
  // moment deletion starts.
  const rowRef = useRef<HTMLDivElement | null>(null);
  const [collapsedHeight, setCollapsedHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!isDeleting) {
      setCollapsedHeight(null);
      return;
    }
    if (!rowRef.current) return;
    const h = rowRef.current.getBoundingClientRect().height;
    setCollapsedHeight(h);
    const t = setTimeout(() => setCollapsedHeight(0), 180);
    return () => clearTimeout(t);
  }, [isDeleting]);
  const setRefs = (el: HTMLDivElement | null) => {
    rowRef.current = el;
    innerRef?.(el);
  };
  // True if the pointer moved more than ~10px during the gesture. Used to
  // swallow the click that the browser fires on release — if the user
  // dragged (e.g. the sheet up/down with their finger on a segment), the
  // tap shouldn't open the segment.
  const didMoveRef = useRef(false);

  const clearLongPress = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  // Always-on pointer tracking for the drag-suppression flag (separate
  // from the long-press tracking, which is conditional on
  // onLongPressActivate being passed — when the card is expanded the
  // parent omits that callback, but we still want to swallow drag-clicks).
  const handlePointerDownAlways = (e: React.PointerEvent) => {
    if (e.button === 2) return;
    didMoveRef.current = false;
    if (!startPosRef.current) startPosRef.current = { x: e.clientX, y: e.clientY };
  };
  const handlePointerMoveAlways = (e: React.PointerEvent) => {
    const start = startPosRef.current;
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (Math.hypot(dx, dy) > 10) didMoveRef.current = true;
  };

  return (
    <div
      ref={setRefs}
      onClickCapture={e => {
        // Either a long-press fired (drag-reorder activation) OR the
        // pointer moved enough to count as a drag (sheet pull, scroll,
        // etc.). Either way, the click is unintended — swallow it.
        if (didLongPressRef.current || didMoveRef.current) {
          e.stopPropagation();
          e.preventDefault();
          didLongPressRef.current = false;
          didMoveRef.current = false;
        }
      }}
      onPointerDown={(e) => {
        handlePointerDownAlways(e);
        if (!onLongPressActivate || e.button === 2) return;
        didLongPressRef.current = false;
        startPosRef.current = { x: e.clientX, y: e.clientY };
        capturedRef.current = { target: e.target as Element, pointerId: e.pointerId };
        const sx = e.clientX;
        const sy = e.clientY;
        longPressTimerRef.current = setTimeout(() => {
          longPressTimerRef.current = null;
          didLongPressRef.current = true;
          const cap = capturedRef.current;
          if (cap && cap.target.hasPointerCapture?.(cap.pointerId)) {
            cap.target.releasePointerCapture(cap.pointerId);
          }
          onLongPressActivate(index, sx, sy);
        }, 300);
      }}
      onPointerMove={(e) => {
        handlePointerMoveAlways(e);
        if (!onLongPressActivate) return;
        const start = startPosRef.current;
        if (!start) return;
        const dx = e.clientX - start.x;
        const dy = e.clientY - start.y;
        if (Math.hypot(dx, dy) > 8) clearLongPress();
      }}
      onPointerUp={() => {
        clearLongPress();
        startPosRef.current = null;
      }}
      onPointerCancel={() => {
        clearLongPress();
        startPosRef.current = null;
      }}
      style={{
        marginBottom: collapsedHeight === 0 ? 0 : 9,
        height: collapsedHeight != null ? collapsedHeight : undefined,
        overflow: isDeleting ? 'hidden' : undefined,
        position: 'relative',
        zIndex: isGrabbed ? 5 : undefined,
        transform,
        // Compose the parent-driven transition list with our own height /
        // margin transitions so all four animate together while a delete
        // is in flight. Height transition timing is matched to the inner
        // scale duration (180ms) — phase 1 finishes just as phase 2
        // begins, giving the row a continuous zoom-then-collapse.
        transition: `${transition}, height 0.18s ease, margin-bottom 0.18s ease`,
        // Drop shadow lives here (emerges from the visible card outline
        // when grabbed). Halo ring is on the absolute child below,
        // positioned at the bottom face's location so it hugs the lower
        // layer instead of extending the full 3.5px above the top face
        // — same recipe as PreviewTile in RouletteScreen and BlockRow in
        // BlocksList.
        boxShadow: isGrabbed ? '0 12px 24px rgba(0,0,0,0.18)' : 'none',
        borderRadius: 21,
        touchAction: isGrabbed ? 'none' : undefined,
        WebkitTouchCallout: 'none',
        userSelect: 'none',
        WebkitUserSelect: 'none',
      }}
    >
      {/* Scale wrapper — only animates on delete. Wrapping (not styling
          the outer row) keeps the existing translateY/scale transform
          chain on the row untouched, so drag-reorder and slot-shift
          aren't disturbed. Transform / opacity / transition are ALWAYS
          set (not toggled to/from undefined) so the transition rule is
          on the element the render BEFORE `isDeleting` flips — without
          this the value would jump from `none` straight to `scale(0)`
          on the same render that introduces the transition, and the
          browser would skip the animation entirely (perceived as a
          flicker). */}
      <div style={{
        transformOrigin: 'center',
        transform: isDeleting ? 'scale(0)' : 'scale(1)',
        opacity: isDeleting ? 0 : 1,
        transition: 'transform 0.18s cubic-bezier(0.4, 0, 1, 1), opacity 0.18s ease',
      }}>
        {/* Halo is rendered INSIDE the SwipeableActionCell now (via its
            `halo` prop) so it z-stacks above the action buttons but below
            the card's translate layer. See SwipeableActionCell for the
            structural reasoning. */}
        {children}
      </div>
    </div>
  );
}

// Lock the parent scroll container while a row is being dragged. Walks up
// from the grabbed row and freezes overflow + touch-action on every
// scrollable ancestor, restoring on release. Same recipe as BlocksList.

// ── Setting Slider ────────────────────────────────────────────────────────

function SettingSlider({ label, value, min, max, step, onChange, onChangeEnd }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  onChangeEnd?: () => void;
}) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      marginBottom: 12,
    }}>
      <span style={{ width: 100, fontWeight: 600, fontSize: 14 }}>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        onPointerUp={onChangeEnd}
        onTouchEnd={onChangeEnd}
        style={{ flex: 1, accentColor: ON_SURFACE }}
      />
      <span style={{ width: 44, textAlign: 'right', fontWeight: 700, fontSize: 13 }}>
        {max > 10 ? value.toFixed(0) : value.toFixed(1)}
      </span>
    </div>
  );
}
