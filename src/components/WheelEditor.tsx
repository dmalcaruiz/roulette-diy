import { useState, useCallback, useRef, useEffect } from 'react';
import { WheelConfig, WheelItem } from '../models/types';
import { InsetTextField, PushDownButton } from './PushDownButton';
import { oklchShadow, withAlpha, colorToHex, hexStringToColor } from '../utils/colorUtils';
import { HexColorPicker } from 'react-colorful';
import { SEGMENT_COLORS, ON_SURFACE, BORDER, PRIMARY, BG, SURFACE, SURFACE_ELEVATED } from '../utils/constants';
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
}: WheelEditorProps) {
  const configId = initialConfig?.id ?? Date.now().toString();
  const { state, set, patch, commit, undo, redo } = history;
  const { segments, name } = state;

  // UI-only state
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
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
  const segmentsRef = useRef(segments);
  segmentsRef.current = segments;

  // Keep a ref to current state for use in pointer handlers
  const stateRef = useRef(state);
  stateRef.current = state;

  // Initial preview
  useEffect(() => {
    if (!onPreview || !state.name.trim()) return;
    onPreview(stateToConfig(state, configId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    commitWithAnim([...stateRef.current.segments, newSegment]);
  };

  const removeSegment = (index: number) => {
    if (stateRef.current.segments.length <= 2) return;
    setExpandedIndex(null);
    commitWithAnim(stateRef.current.segments.filter((_, i) => i !== index));
  };

  const duplicateSegment = (index: number) => {
    const original = stateRef.current.segments[index];
    const id = `${segmentIdCounter++}`;
    const newSegs = [...stateRef.current.segments];
    newSegs.splice(index + 1, 0, { ...original, id });
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
  const SEGMENT_ROW_GAP = 8;

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
    const bgColor = isExpanded ? SURFACE : segment.color;
    const borderColor = isExpanded ? segment.color : oklchShadow(segment.color, 0.06);
    const bottomColor = oklchShadow(isExpanded ? segment.color : segment.color);
    const textColor = isExpanded ? ON_SURFACE : '#FFFFFF';

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
            transition: 'background-color 0.2s, border-color 0.2s',
          }}>
            {/* Collapsed row */}
            <div
              onClick={() => setExpandedIndex(isExpanded ? null : index)}
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '8px 0',
                cursor: 'pointer',
              }}
            >
              <div
                style={{ padding: '0 14px', touchAction: 'none', cursor: isExpanded ? 'default' : 'grab' }}
                onPointerDown={isExpanded ? undefined : (e) => handleGripPointerDown(index, e)}
              >
                <GripVertical size={22} color={isExpanded ? withAlpha(ON_SURFACE, 0.3) : 'rgba(255,255,255,0.6)'} />
              </div>
              <div
                style={{ flex: 1 }}
                onClick={isExpanded ? (e) => e.stopPropagation() : undefined}
                onPointerDown={isExpanded ? (e) => e.stopPropagation() : undefined}
              >
                {isExpanded ? (
                  <InsetTextField
                    value={segment.text}
                    onChange={v => patchSegment(index, { text: v })}
                    onBlur={commit}
                    placeholder="Segment name"
                    inputStyle={{ fontWeight: 600, fontSize: 16, color: ON_SURFACE }}
                  />
                ) : (
                  <div style={{
                    padding: '10px 12px',
                    fontWeight: 600,
                    fontSize: 16,
                    color: textColor,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}>
                    {segment.text}
                  </div>
                )}
              </div>
              <div style={{
                padding: '0 14px',
                transform: `rotate(${isExpanded ? 180 : 0}deg)`,
                transition: 'transform 0.2s',
              }}>
                <ChevronDown size={26} color={isExpanded ? withAlpha(ON_SURFACE, 0.35) : 'rgba(255,255,255,0.6)'} />
              </div>
            </div>

            {/* Expanded content */}
            {isExpanded && (
              <div
                onClick={e => e.stopPropagation()}
                style={{ padding: '0 14px 14px' }}
              >
                {/* Weight controls */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                  <PushDownButton
                    color={SURFACE_ELEVATED}
                    borderRadius={10}
                    height={36}
                    bottomBorderWidth={3}
                    onTap={() => {
                      const newSegs = state.segments.map((s, i) =>
                        i === index ? { ...s, weight: Math.max(0.1, s.weight - 0.1) } : s
                      );
                      set({ ...state, segments: newSegs });
                    }}
                    style={{ width: 36 }}
                  >
                    <Minus size={16} color={ON_SURFACE} />
                  </PushDownButton>
                  <div style={{ flex: 1, textAlign: 'center', fontWeight: 700, fontSize: 14 }}>
                    Weight: {segment.weight.toFixed(1)}
                  </div>
                  <PushDownButton
                    color={SURFACE_ELEVATED}
                    borderRadius={10}
                    height={36}
                    bottomBorderWidth={3}
                    onTap={() => {
                      const newSegs = state.segments.map((s, i) =>
                        i === index ? { ...s, weight: Math.min(10, s.weight + 0.1) } : s
                      );
                      set({ ...state, segments: newSegs });
                    }}
                    style={{ width: 36 }}
                  >
                    <Plus size={16} color={ON_SURFACE} />
                  </PushDownButton>
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
                      backgroundColor: SURFACE_ELEVATED,
                      border: `1.5px solid ${BORDER}`,
                      cursor: 'pointer',
                      fontSize: 14,
                      fontWeight: 600,
                    }}
                  >
                    <Palette size={18} />
                    <div style={{
                      width: 20, height: 20,
                      borderRadius: '50%',
                      backgroundColor: segment.color,
                      border: `1.5px solid ${BORDER}`,
                    }} />
                  </button>
                </div>

                {/* Inline color picker */}
                {colorPickerSegment === index && (
                  <div style={{ marginTop: 12 }}>
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
                          border: `1.5px solid ${BORDER}`,
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
        trailingActions={[
          {
            color: PRIMARY,
            icon: <Copy size={20} />,
            onTap: () => duplicateSegment(index),
          },
          {
            color: '#EF4444',
            icon: <Trash2 size={20} />,
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

      <SettingSlider label="Stroke Width" value={state.strokeWidth} min={0} max={10} step={0.1}
        onChange={v => patch({ strokeWidth: v })} onChangeEnd={commit} />
      <SettingSlider label="Center Marker" value={state.centerMarkerSize} min={100} max={250} step={1}
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
            <>
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
                // Halo color tracks each segment's bottom-face color so a
                // colored card's ring matches its own palette.
                const haloColor = oklchShadow(seg.color);
                return (
                  <SegmentRow
                    key={seg.id}
                    innerRef={el => { segmentElsRef.current[i] = el; }}
                    index={i}
                    isGrabbed={isGrabbed}
                    transform={transform}
                    transition={transition}
                    haloColor={haloColor}
                    // Long-press is gated to the collapsed state — when the
                    // card is open, all the inner controls (color picker,
                    // weight buttons, text input) need raw pointer access.
                    onLongPressActivate={expandedIndex === i ? undefined : handleGrabStart}
                  >
                    {renderSegmentCard(seg, i)}
                  </SegmentRow>
                );
              })}
              <div style={{ height: 12 }} />
              <PushDownButton color={PRIMARY} onTap={addSegment}>
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 10,
                  color: '#FFFFFF',
                }}>
                  <Plus size={22} />
                  <span style={{ fontWeight: 700, fontSize: 15 }}>Add Segment</span>
                </div>
              </PushDownButton>
              <div style={{ height: 32 }} />
            </>
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
  index, isGrabbed, transform, transition, haloColor, onLongPressActivate, innerRef, children,
}: {
  index: number;
  isGrabbed: boolean;
  transform: string;
  transition: string;
  // Hex color of the row's halo ring (per-segment in WheelEditor since
  // each card is colored). The 25% alpha is appended here.
  haloColor: string;
  onLongPressActivate?: (index: number, startX: number, startY: number) => void;
  innerRef?: (el: HTMLDivElement | null) => void;
  children: React.ReactNode;
}) {
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startPosRef = useRef<{ x: number; y: number } | null>(null);
  const capturedRef = useRef<{ target: Element; pointerId: number } | null>(null);
  const didLongPressRef = useRef(false);

  const clearLongPress = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  return (
    <div
      ref={innerRef}
      onClickCapture={e => {
        if (didLongPressRef.current) {
          e.stopPropagation();
          e.preventDefault();
          didLongPressRef.current = false;
        }
      }}
      onPointerDown={onLongPressActivate ? (e => {
        if (e.button === 2) return;
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
      }) : undefined}
      onPointerMove={onLongPressActivate ? (e => {
        const start = startPosRef.current;
        if (!start) return;
        const dx = e.clientX - start.x;
        const dy = e.clientY - start.y;
        if (Math.hypot(dx, dy) > 8) clearLongPress();
      }) : undefined}
      onPointerUp={onLongPressActivate ? (() => {
        clearLongPress();
        startPosRef.current = null;
      }) : undefined}
      onPointerCancel={onLongPressActivate ? (() => {
        clearLongPress();
        startPosRef.current = null;
      }) : undefined}
      style={{
        marginBottom: 8,
        position: 'relative',
        zIndex: isGrabbed ? 5 : undefined,
        transform,
        transition,
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
      {/* Halo ring — same shape & position as the bottom face inside
          the card (top: 6.5 inset, bottom-aligned to the row). The
          3.5px boxShadow lands above the top face by only y=3 inside
          the row instead of y=−3.5 above it, so the ring hugs the
          bottom layer instead of wrapping the full perimeter. */}
      <div style={{
        position: 'absolute',
        left: 0,
        right: 0,
        top: 6.5,
        bottom: 0,
        borderRadius: 21,
        boxShadow: `0 0 0 3.5px ${haloColor}40`,
        pointerEvents: 'none',
      }} />
      {children}
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
