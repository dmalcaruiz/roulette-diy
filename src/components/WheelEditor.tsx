import { useState, useCallback, useRef, useEffect, type ReactNode } from 'react';
import { WheelConfig, WheelItem } from '../models/types';
import { InsetTextField, PushDownButton } from './PushDownButton';
import { deriveCardSurfaces, withAlpha, colorToHex, hexStringToColor, oklchShadow, oklchHighlight } from '../utils/colorUtils';
import { HexColorPicker } from 'react-colorful';
import { SEGMENT_COLORS, ON_SURFACE, BORDER, PRIMARY, BG, SURFACE_ELEVATED } from '../utils/constants';
import {
  GripVertical, ChevronDown, Plus, Minus, Palette, Image, Trash2,
  Copy, CopyPlus, ClipboardPaste, MoreHorizontal, Circle, Settings,
  Type, Heading, PieChart, Disc, MapPin, WrapText, Volume2, PartyPopper,
} from 'lucide-react';
import SwipeableActionCell, { closeActiveSwipeCell } from './SwipeableActionCell';
import DraggableSheet from './DraggableSheet';
import { OUTER_DOTS_MIN_STROKE, OUTER_DOTS_MAX_CORNER } from './WheelCanvas';
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
  outerStrokeWidth: number;
  outerStrokeDots: boolean;
  textWrap: boolean;
  showBackgroundCircle: boolean;
  // One base colour for all wheel chrome — it tints the ring/dividers/bg
  // circle AND the centre marker (stateToConfig fans it out to the config's
  // separate wheelBaseColor + markerBaseColor render fields). The editor only
  // ever sets this single value; the marker no longer has its own colour.
  wheelBaseColor: string;
  markerDiameter: number;
  markerPeek: number;
  innerCornerStyle: 'none' | 'rounded' | 'circular' | 'straight';
  centerInset: number;
  segmentsMode: 'list' | 'cards';
  // Tick sound — 'click' (sampled) or a synth voice. Win arpeggio always plays.
  tickSound: 'click' | 'blip' | 'fire' | 'ding' | 'zap';
  // Result dialog + dot celebration as the win overlay fades out.
  resultDialog: boolean;
  // Wheel id this state was initialized FROM (via buildInitialState). Used
  // by the [state, onPreview, configId] useEffect to detect the brief
  // mid-switch race where state still carries the previous wheel's data
  // but configId has already updated — comparing this against configId
  // lets us drop the stale preview before it overwrites previewConfig
  // with mismatched items.
  originWheelId?: string;
}

interface WheelEditorProps {
  initialConfig?: WheelConfig | null;
  // Unique identifier of the wheel this editor instance is editing.
  // Used by the mid-switch race guard in the [state, onPreview] useEffect:
  // we compare state.originWheelId (stamped at buildInitialState time)
  // against this prop to detect when state still belongs to the previous
  // wheel mid-switch and skip the stale onPreview call. Use block.id
  // here (which `useHistory` already uses as `resetKey`) rather than
  // wheelConfig.id — in some data setups multiple blocks share a single
  // wheelConfig.id, so it can't tell wheels apart.
  wheelId?: string;
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
  // When false, the heavy segment list is not rendered (a cheap spacer
  // takes its place). The hosting screen sets this false while the sheet
  // is closed so that switching wheels — which only happens with the
  // sheet closed — doesn't pay the cost of reconciling the (invisible)
  // segment rows. It flips true the moment the sheet opens, mounting the
  // rows then. Defaults to true (e.g. the always-visible desktop editor).
  // NOTE: this only gates RENDERING; the editor's history/state stay live
  // and correct, so previews and the visible wheel are unaffected.
  renderRows?: boolean;
  // Current height (px) of the hosting sheet, so List mode can size its
  // textarea to fill the sheet (and grow when the sheet is dragged to a
  // taller snap) instead of a fixed height that wastes space or overflows.
  // Omitted on desktop (no sheet) — falls back to a fixed height there.
  sheetHeight?: number;
  // True when hosted in the phone sheet. Widens the offscreen-card render
  // window once the sheet has settled open, so fast flings don't outrun it
  // and show cards popping in — see SEG_WINDOW_BUFFER_PHONE / widenPhoneWindow.
  // Defaults false so the desktop sidebar keeps the narrow window.
  isMobile?: boolean;
  // Segment-header visibility. Lifted in the hosting screen (it drives
  // wheel-canvas layout there too), but surfaced *here* in the Style tab,
  // co-located with the "Header Text" size it governs — so an off header
  // doesn't leave a dead size slider behind. When the toggle handler is
  // omitted (legacy/desktop with no header concept), the Style tab falls
  // back to always showing the Header Text size control.
  showSegmentHeader?: boolean;
  onToggleSegmentHeader?: (v: boolean) => void;
}

let segmentIdCounter = 0;

// ── Segment clipboard ──────────────────────────────────────────────────────
// Copy/Paste of a single segment, persisted to localStorage so it survives
// navigating between wheels and reloads (mirrors the wheel clipboard in
// RouletteScreen). JSON round-trip also deep-clones. A payload only counts as
// pasteable if it's structurally a segment, so stale/garbage data stays hidden.
const SEGMENT_CLIPBOARD_KEY = 'roulette:segmentClipboard';
// Paste is only offered for this long after the Copy press (see the freshness
// check at the Paste row). Past it, Paste hides even with valid data.
const SEGMENT_PASTE_TTL_MS = 3 * 60 * 1000;
interface SegmentClipboard {
  segment: SegmentData;
  copiedAt: number; // epoch ms of the Copy press, for the TTL above
}
function isValidSegmentData(v: unknown): v is SegmentData {
  return !!v && typeof v === 'object'
    && typeof (v as SegmentData).text === 'string'
    && typeof (v as SegmentData).color === 'string'
    && typeof (v as SegmentData).weight === 'number';
}
function readSegmentClipboard(): SegmentClipboard | null {
  try {
    const raw = localStorage.getItem(SEGMENT_CLIPBOARD_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { segment?: unknown; copiedAt?: unknown };
    if (parsed && isValidSegmentData(parsed.segment) && typeof parsed.copiedAt === 'number') {
      return { segment: parsed.segment, copiedAt: parsed.copiedAt };
    }
    localStorage.removeItem(SEGMENT_CLIPBOARD_KEY);
    return null;
  } catch {
    return null;
  }
}
function writeSegmentClipboard(seg: SegmentData): void {
  try {
    localStorage.setItem(SEGMENT_CLIPBOARD_KEY, JSON.stringify({ segment: seg, copiedAt: Date.now() }));
  } catch {
    /* storage unavailable / quota — copy silently no-ops */
  }
}

// Measure rendered text width (cached canvas) so a collapsed-card tap can tell
// whether it landed on the written text vs the empty space after it. Returns
// Infinity if measuring isn't possible, so callers default to "on text".
let _measureCanvas: HTMLCanvasElement | null = null;
function measureTextWidth(text: string, font: string): number {
  if (!_measureCanvas) _measureCanvas = document.createElement('canvas');
  const ctx = _measureCanvas.getContext('2d');
  if (!ctx) return Infinity;
  ctx.font = font;
  return ctx.measureText(text).width;
}

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

export function buildInitialState(config?: WheelConfig | null, wheelId?: string): EditorState {
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
    outerStrokeWidth: config?.outerStrokeWidth ?? 0,
    outerStrokeDots: config?.outerStrokeDots ?? false,
    textWrap: config?.textWrap ?? false,
    showBackgroundCircle: config?.showBackgroundCircle ?? true,
    wheelBaseColor: config?.wheelBaseColor ?? '#FFFFFF',
    markerDiameter: config?.markerDiameter ?? 60,
    markerPeek: config?.markerPeek ?? 4,
    innerCornerStyle: config?.innerCornerStyle ?? 'none',
    centerInset: config?.centerInset ?? 50,
    // Migrate the legacy 'simple'/'complex' values from older saved wheels
    // into the new 'list'/'cards' vocabulary. New wheels default to
    // 'cards' (the more expressive editor).
    segmentsMode: ((config?.segmentsMode as unknown) === 'simple' ? 'list'
      : (config?.segmentsMode as unknown) === 'complex' ? 'cards'
      : config?.segmentsMode ?? 'cards'),
    tickSound: config?.tickSound ?? 'click',
    resultDialog: config?.resultDialog ?? false,
    // Use the BLOCK id (which is unique per wheel-in-flow), NOT the
    // wheelConfig.id — in some data setups multiple blocks reference
    // the same wheelConfig id, so the wheelConfig id can't distinguish
    // wheels. block.id IS the resetKey used by useHistory, so this is
    // the same identifier the parent uses to decide when to reset.
    originWheelId: wheelId ?? config?.id,
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
    outerStrokeWidth: state.outerStrokeWidth,
    // Gate on the same conditions as the toggle's visibility, so changing the
    // stroke/corners hides the dots (without losing the user's on/off choice).
    outerStrokeDots: state.outerStrokeDots
      && (state.strokeWidth + state.outerStrokeWidth >= OUTER_DOTS_MIN_STROKE)
      && (state.cornerRadius <= OUTER_DOTS_MAX_CORNER || state.showBackgroundCircle),
    textWrap: state.textWrap,
    showBackgroundCircle: state.showBackgroundCircle,
    wheelBaseColor: state.wheelBaseColor,
    markerDiameter: state.markerDiameter,
    markerPeek: state.markerPeek,
    // Marker shares the one base colour — see EditorState.wheelBaseColor.
    markerBaseColor: state.wheelBaseColor,
    innerCornerStyle: state.innerCornerStyle,
    centerInset: state.centerInset,
    segmentsMode: state.segmentsMode,
    tickSound: state.tickSound,
    resultDialog: state.resultDialog,
  };
}

export default function WheelEditor({
  initialConfig, wheelId, history, onPreview, onClose,
  selectedTab: selectedTabProp, onTabChange, onReorderActiveChange,
  scrollToSegmentIndex, onScrollToSegmentConsumed, renderRows = true, sheetHeight,
  isMobile = false, showSegmentHeader, onToggleSegmentHeader,
}: WheelEditorProps) {
  const configId = initialConfig?.id ?? Date.now().toString();
  const { state, set, patch, commit, undo, redo } = history;
  const { segments, name } = state;

  // UI-only state
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  // Segment actions sheet — holds the index whose sheet is open (null =
  // closed). Opened by a long-press that releases without any drag movement.
  const [segmentActionsIndex, setSegmentActionsIndex] = useState<number | null>(null);
  // Segment clipboard for the sheet's Copy / Paste. Seeded from localStorage
  // so a segment copied in another wheel (or before a reload) can be pasted.
  const [segmentClip, setSegmentClip] = useState<SegmentClipboard | null>(() => readSegmentClipboard());
  // Paste is offered only when there's valid clipboard data AND the Copy
  // happened within the TTL. Evaluated at render — the sheet opens via a
  // state change, so it's fresh each time the sheet appears.
  const canPasteSegment = !!segmentClip && Date.now() - segmentClip.copiedAt < SEGMENT_PASTE_TTL_MS;
  // On collapse, blur whatever input was focused inside the card and
  // clear any text selection so the closing card doesn't leave a
  // highlighted-but-unfocused-and-unreadable trail in the DOM.
  useEffect(() => {
    if (expandedIndex !== null) return;
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    window.getSelection()?.removeAllRanges();
  }, [expandedIndex]);
  // Segment ids that the user just hit delete on but are still in
  // state.segments — kept around for 360ms so the wheel can play its
  // shrink-to-0.001 preview before the actual commit lands. The card
  // for these ids is filtered out of the rendered list immediately
  // (no card-side animation), so only the wheel animates.
  const [pendingDeleteIds, setPendingDeleteIds] = useState<Set<string>>(new Set());
  // After a delete, auto-open the trailing actions of the card that
  // now occupies the deleted card's slot (the one that was directly
  // below in the pre-delete list). `tick` increments on every delete
  // so the matching SwipeableActionCell's open effect re-fires even if
  // the same id auto-opens twice in a row.
  const [autoOpenSpec, setAutoOpenSpec] = useState<{ id: string; tick: number }>({ id: '', tick: 0 });
  // Timestamp of the last delete-button press — used to gate the
  // chain-delete auto-open. Only when two deletes happen within 5
  // seconds does the second one auto-open the card above; an isolated
  // delete leaves the next card closed.
  const lastDeleteTimeRef = useRef<number>(0);
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
  // Weight slider thumb grows only while directly touched/dragged (only one
  // card is expanded at a time, so a single flag covers it). No grow/glide
  // tied to the +/- buttons.
  const [weightThumbDrag, setWeightThumbDrag] = useState(false);

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
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);
  const [isSettling, setIsSettling] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);
  // Live translateY of the grabbed row. A ref (not state) so per-frame
  // pointer tracking updates the row's transform IMPERATIVELY without a
  // React re-render each frame — the Notion-style cheap drag. The render
  // reads this ref for the grabbed row, so the occasional re-render (on a
  // drop-target change) places it correctly; between those, onMove sets
  // the transform directly on the element.
  const dragOffsetRef = useRef(0);
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

  // ── Segment list windowing ──────────────────────────────────────────────
  // Only the rows near the viewport render as full cards; the rest render
  // as cheap fixed-height placeholder divs. This keeps the mount/scroll
  // cost ~constant regardless of segment count, while preserving the
  // drag-reorder logic — every index still has a real DOM element (the
  // placeholder) with the correct height, so the grab-start snapshot and
  // midpoint hit-testing work unchanged. Flip WINDOW_SEGMENTS to false to
  // disable and render every row full (the pre-windowing behaviour).
  const WINDOW_SEGMENTS = true;
  // Rows rendered beyond the viewport on each side. The window starts NARROW
  // (SEG_WINDOW_BUFFER) so the sheet-open animation mounts as few cards as
  // possible during that perf-sensitive frame window. Once the sheet has
  // settled open, phones WIDEN to SEG_WINDOW_BUFFER_PHONE — pre-rendering
  // more offscreen cards so a fast fling doesn't outrun the window and show
  // cards popping in live. Desktop keeps the narrow buffer (mouse-wheel /
  // scrollbar scrolling stays slow enough that the window always keeps up).
  const SEG_WINDOW_BUFFER = 6;
  const SEG_WINDOW_BUFFER_PHONE = 12;
  // Flips true ~100ms after the sheet has finished opening (mobile only),
  // widening the window buffer. Reset to false whenever the list is hidden
  // so the next open again starts narrow (cheap to mount).
  const [widenPhoneWindow, setWidenPhoneWindow] = useState(false);
  // Live buffer the scroll-driven recompute reads. Kept in a ref (mutated
  // during render, same pattern as the callback refs above) so
  // recomputeSegWindow can stay dependency-free and still see the latest
  // value the instant `widenPhoneWindow` flips.
  const segWindowBufferRef = useRef(SEG_WINDOW_BUFFER);
  segWindowBufferRef.current = (isMobile && widenPhoneWindow)
    ? SEG_WINDOW_BUFFER_PHONE
    : SEG_WINDOW_BUFFER;
  // Container wrapping the rows — used to locate the scroll ancestor and
  // measure the list's position for the window calc.
  const listContainerRef = useRef<HTMLDivElement | null>(null);
  const scrollElRef = useRef<HTMLElement | null>(null);
  // Measured uniform row height incl. the SEGMENT_ROW_GAP marginBottom.
  // Seeded with an estimate; refined from a real row on first measure.
  const rowHeightRef = useRef(82);
  // Initial window is small — the sheet always opens scrolled to the top
  // (closing collapses the list to a spacer, which clamps scrollTop to 0),
  // so the first paint only needs to cover a viewport-ful from row 0. The
  // scroll-driven recompute (one rAF later) widens/repositions it. Keeping
  // this tight is what makes a 150-row open mount ~a dozen cards instead of
  // ~25 on the first frame.
  const [segWindow, setSegWindow] = useState<{ start: number; end: number }>({ start: 0, end: 12 });

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
      // Arithmetic target — the row may be virtualized out of the DOM, so we
      // can't measure it. Its top within the list is idx * rowH (uniform).
      // The spacers reserve the full scroll height, so scrollHeight is right
      // and the scroll lands correctly; the recompute fired by this scroll
      // then renders the row as it comes into view.
      const listEl = listContainerRef.current;
      if (!listEl) { onScrollToSegmentConsumed?.(); return; }
      let scrollEl: HTMLElement | null = listEl.parentElement;
      while (scrollEl) {
        const cs = getComputedStyle(scrollEl);
        if (/(auto|scroll)/.test(cs.overflowY) || /(auto|scroll)/.test(cs.overflow)) {
          if (scrollEl.scrollHeight > scrollEl.clientHeight + 1) break;
        }
        scrollEl = scrollEl.parentElement;
      }
      if (!scrollEl) { onScrollToSegmentConsumed?.(); return; }
      const rowH = rowHeightRef.current;
      const listRect = listEl.getBoundingClientRect();
      const scRect = scrollEl.getBoundingClientRect();
      const rowTopViewport = listRect.top + idx * rowH;
      // Centre the row in the scroll viewport (or as close as the
      // scrollable extent allows).
      const targetCentre = rowTopViewport + rowH / 2 - scRect.top - scRect.height / 2;
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
    // Mid-switch race guard: state.originWheelId is stamped by
    // buildInitialState with the BLOCK id at reset time. When this
    // effect fires mid-switch the parent has already updated `wheelId`
    // to the new block but `state` (via useHistory's pre-reset hist) may
    // still carry the previous wheel's segments — comparing them lets
    // us drop that stale preview before it lands in previewConfig and
    // flashes the wrong content in active-tile thumbnails. The next
    // render (after useHistory's reset propagates to state) re-fires
    // this effect with matching ids and the preview lands then.
    // eslint-disable-next-line no-console
    console.log(`[WE-DBG] useEffect fires: originWheelId=${state.originWheelId ?? 'UNDEF'} wheelId=${wheelId ?? 'UNDEF'} segmentsLen=${state.segments.length}`);
    if (wheelId && state.originWheelId && state.originWheelId !== wheelId) {
      // eslint-disable-next-line no-console
      console.log(`[WE-DBG] SKIPPED: origin=${state.originWheelId} vs wheelId=${wheelId}`);
      return;
    }
    onPreview(stateToConfig(state, configId));
  }, [state, onPreview, configId, wheelId]);

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
    // Snap any swipe-revealed card back to rest so the add gesture
    // doesn't leave a stray hanging-open cell behind the new segment.
    closeActiveSwipeCell();
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
    // Kick the wheel's segment-shrink preview off IMMEDIATELY, then
    // commit the actual filter after the wheel animation window — the
    // timeout is what gives the wheel time to play its shrink before
    // the commit lands. The card just unmounts (no card-side animation).
    const prev = stateRef.current.segments;
    sendPreview(prev.map(s => s.id === segment.id ? { ...s, weight: 0.001 } : s));
    setPendingDeleteIds(s => { const n = new Set(s); n.add(segment.id); return n; });
    // Auto-swipe-open the card directly ABOVE the deleted one — but
    // ONLY if (a) this delete fires within 5s of the previous one
    // (chain-delete gesture), AND (b) more than one segment remains
    // after this delete. An isolated delete or the last-pair delete
    // leaves the next card closed. Bumping `tick` makes the open
    // effect re-fire even if the same id auto-opens twice in a row.
    const now = Date.now();
    const isChainDelete = now - lastDeleteTimeRef.current < 4000;
    lastDeleteTimeRef.current = now;
    const willHaveMultipleLeft = prev.length - 1 > 1;
    const nextSegment = prev[index - 1];
    if (isChainDelete && willHaveMultipleLeft && nextSegment) {
      setAutoOpenSpec(s => ({ id: nextSegment.id, tick: s.tick + 1 }));
    }
    setTimeout(() => {
      set({ ...stateRef.current, segments: stateRef.current.segments.filter(s => s.id !== segment.id) });
      setPendingDeleteIds(s => { const n = new Set(s); n.delete(segment.id); return n; });
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

  // Copy the segment's data onto the clipboard (deep-cloned via localStorage
  // JSON). Paste reassigns a fresh id, so the original is untouched.
  const copySegment = (index: number) => {
    const seg = stateRef.current.segments[index];
    if (!seg) return;
    writeSegmentClipboard(seg);
    setSegmentClip(readSegmentClipboard());
  };

  // Insert the clipboard segment right after `index` (same shape as duplicate,
  // but the data comes from the clipboard rather than the source row).
  const pasteSegment = (index: number) => {
    if (!segmentClip) return;
    const id = `${segmentIdCounter++}`;
    const newSegs = [...stateRef.current.segments];
    newSegs.splice(index + 1, 0, { ...segmentClip.segment, id });
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
    // Uniform row height (incl. gap) — no per-row measurement needed.
    const slot = rowHeightRef.current;
    if (dropTargetIndex > grabbedIndex) {
      if (i > grabbedIndex && i <= dropTargetIndex) return -slot;
    } else if (dropTargetIndex < grabbedIndex) {
      if (i >= dropTargetIndex && i < grabbedIndex) return slot;
    }
    return 0;
  };

  // Map a viewport Y coordinate to a segment index arithmetically (uniform
  // row height). Used by the left-edge grip strip in place of iterating
  // every row's getBoundingClientRect — works even when most rows are
  // virtualized out of the DOM. Only called while collapsed (the strip is
  // hidden when a card is expanded), so the height is uniform.
  const indexFromClientY = (clientY: number): number | null => {
    const listEl = listContainerRef.current;
    if (!listEl) return null;
    const listTop = listEl.getBoundingClientRect().top;
    const rowH = rowHeightRef.current;
    const idx = Math.floor((clientY - listTop) / rowH);
    if (idx < 0 || idx >= segmentsRef.current.length) return null;
    return idx;
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

    // Arithmetic positioning — uniform row height means we never measure
    // 150 rows (the old getBoundingClientRect loop was a forced reflow and
    // the main reorder cost). We capture the list's top edge once and the
    // measured row height; everything else is `index * rowH`.
    const rowH = rowHeightRef.current;
    const listTop = listContainerRef.current?.getBoundingClientRect().top ?? 0;

    let currentTarget = sourceIndex;
    // Tracks whether the pointer ever moved past the drag threshold. A
    // long-press that releases with NO movement isn't a reorder — it
    // dismisses the grab and opens the segment actions sheet instead.
    let didMove = false;
    dragOffsetRef.current = 0;
    setGrabbedIndex(sourceIndex);
    setDropTargetIndex(sourceIndex);
    // Collapse the card on grab — its expanded controls would otherwise
    // jitter the slot-shift math and aren't relevant during drag. (Also
    // keeps the list at a uniform row height so the windowing stays exact.)
    setExpandedIndex(null);

    const onMove = (me: PointerEvent) => {
      const dx = me.clientX - startX;
      const dy = me.clientY - startY;
      dragOffsetRef.current = dy;
      // Imperatively follow the pointer — no React state, no per-frame
      // re-render. The render reads dragOffsetRef on its occasional
      // (drop-target-change) re-renders, so the two stay consistent.
      const gEl = segmentElsRef.current[sourceIndex];
      if (gEl) gEl.style.transform = `translateY(${dy}px) scale(1.04)`;
      // 10px threshold before shifting neighbors — avoids twitchy slot
      // indicators on sub-pixel jitter at start.
      if (Math.hypot(dx, dy) < 10) return;
      didMove = true;
      // Drop target straight from the pointer position — O(1), no DOM reads.
      const total = segmentsRef.current.length;
      let target = Math.floor((me.clientY - listTop) / rowH);
      target = Math.max(0, Math.min(target, total - 1));
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
      dragOffsetRef.current = 0;
      setDropTargetIndex(null);
      setIsSettling(false);
      onReorderActiveChange?.(false);
      // Clear the drag-click-suppression flag at end-of-gesture instead
      // of waiting for the post-drag synthetic click — that click often
      // doesn't fire (pointer capture released mid-gesture, gesture
      // ended far from start), leaving the flag stale and absorbing the
      // user's next real tap. Defer one frame so any synthetic click
      // that DOES fire still sees the flag and gets suppressed.
      requestAnimationFrame(() => { didDragRef.current = false; });
    };

    const releaseToTarget = () => {
      // Glide distance is purely (target − source) rows of uniform height.
      const finalOffset = (currentTarget - sourceIndex) * rowH;
      dragOffsetRef.current = finalOffset;
      // setIsSettling re-renders; the grabbed row then renders at finalOffset
      // with the 0.22s settle transition, animating from its current
      // (imperative) transform to the drop slot.
      setIsSettling(true);
      settleTimeoutRef.current = setTimeout(() => {
        settleTimeoutRef.current = null;
        setIsCommitting(true);
        finishRelease(true);
        requestAnimationFrame(() => setIsCommitting(false));
      }, 220);
    };

    const onUp = () => {
      cleanup();
      if (!didMove) {
        // Long-press with no drag → not a reorder. Drop the grab and open
        // the segment actions sheet for this row.
        finishRelease(false);
        setSegmentActionsIndex(sourceIndex);
      } else if (currentTarget !== sourceIndex) {
        releaseToTarget();
      } else {
        finishRelease(false);
      }
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

  // Recompute which rows fall inside the render window from the scroll
  // ancestor's live position. Uniform row height makes this exact; the
  // generous buffer absorbs the small offset introduced by the single
  // (taller) expanded card, so we don't need per-row height math. Reads
  // everything from refs/DOM so it has no reactive deps and stays stable.
  const recomputeSegWindow = useCallback(() => {
    if (!WINDOW_SEGMENTS) return;
    const listEl = listContainerRef.current;
    const scrollEl = scrollElRef.current;
    const total = segmentsRef.current.length;
    // No scrollable ancestor (e.g. the desktop sidebar, overflow:hidden) —
    // windowing can't track scroll there, so render every row full.
    if (!listEl || !scrollEl) {
      setSegWindow(prev => (prev.start === 0 && prev.end === total - 1
        ? prev : { start: 0, end: Math.max(0, total - 1) }));
      return;
    }
    // Refine the row height from any rendered collapsed row (placeholders
    // share the same height, so either works; skip the tall expanded one).
    const els = segmentElsRef.current;
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      if (el && el.offsetHeight > 20 && el.offsetHeight < 150) {
        rowHeightRef.current = el.offsetHeight + SEGMENT_ROW_GAP;
        break;
      }
    }
    const rowH = rowHeightRef.current;
    const listRect = listEl.getBoundingClientRect();
    const scRect = scrollEl.getBoundingClientRect();
    const above = scRect.top - listRect.top; // px of list scrolled above the viewport top
    const buffer = segWindowBufferRef.current;
    const start = Math.max(0, Math.floor(above / rowH) - buffer);
    const end = Math.min(total - 1, Math.ceil((above + scRect.height) / rowH) + buffer);
    setSegWindow(prev => (prev.start === start && prev.end === end ? prev : { start, end }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Attach the scroll listener (and do the initial window calc) whenever
  // the list becomes visible. Finds the nearest scrollable ancestor of the
  // list container — works for both the mobile sheet and desktop sidebar.
  useEffect(() => {
    if (!WINDOW_SEGMENTS || !renderRows) return;
    const listEl = listContainerRef.current;
    let scrollEl: HTMLElement | null = null;
    let cur = listEl?.parentElement ?? null;
    while (cur) {
      const cs = getComputedStyle(cur);
      if (/(auto|scroll)/.test(cs.overflowY) || /(auto|scroll)/.test(cs.overflow)) { scrollEl = cur; break; }
      cur = cur.parentElement;
    }
    scrollElRef.current = scrollEl;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(recomputeSegWindow);
    };
    scrollEl?.addEventListener('scroll', onScroll, { passive: true });
    raf = requestAnimationFrame(recomputeSegWindow);
    return () => {
      cancelAnimationFrame(raf);
      scrollEl?.removeEventListener('scroll', onScroll);
    };
  }, [renderRows, recomputeSegWindow]);

  // Recompute after layout-affecting changes: expand/collapse (shifts rows)
  // and add/delete (changes total). Runs a frame later so the new layout
  // has settled before we measure.
  useEffect(() => {
    if (!WINDOW_SEGMENTS || !renderRows) return;
    const raf = requestAnimationFrame(recomputeSegWindow);
    return () => cancelAnimationFrame(raf);
  }, [expandedIndex, segments.length, renderRows, recomputeSegWindow]);

  // Widen the render window only AFTER the sheet has settled open (phones
  // only). renderRows flips true as the open animation starts; we wait out
  // that ~280ms SnappingSheet height transition + a 100ms buffer before
  // pre-rendering the extra offscreen cards, so that mounting them happens
  // while the sheet is at rest rather than competing with the open frame
  // budget. Resets the instant the list hides, so the next open starts
  // narrow (and therefore cheap to mount).
  useEffect(() => {
    if (!WINDOW_SEGMENTS || !isMobile || !renderRows) {
      setWidenPhoneWindow(false);
      return;
    }
    const SHEET_OPEN_MS = 280;        // SnappingSheet height transition
    const SETTLE_AFTER_OPEN_MS = 100; // grace once it's actually open
    const id = setTimeout(() => {
      setWidenPhoneWindow(true);
      requestAnimationFrame(recomputeSegWindow);
    }, SHEET_OPEN_MS + SETTLE_AFTER_OPEN_MS);
    return () => clearTimeout(id);
  }, [isMobile, renderRows, recomputeSegWindow]);

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
      <div
        key={segment.id}
        style={{ paddingBottom: 6.5 }}
        // Desktop right-click → segment actions sheet (mirrors the preview
        // tiles). Only while collapsed, so right-clicking an expanded card's
        // text field still gives the native copy/paste menu during editing.
        onContextMenu={isExpanded ? undefined : (e) => {
          e.preventDefault();
          setSegmentActionsIndex(index);
        }}
      >
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
                onClick={isExpanded ? (e) => e.stopPropagation() : (e) => {
                  // Tap-on-text while collapsed: the click bubbles to the
                  // parent (which expands the card), and we focus the input
                  // HERE, synchronously, inside the click handler — so it
                  // lands within the tap's user-activation window. A deferred
                  // (rAF) focus runs outside that window, so the mobile
                  // keyboard never opens and it reads as "not focused". The
                  // field is readOnly while collapsed, so clear that
                  // imperatively first (else focus won't summon the keyboard);
                  // React keeps readOnly=false once the expand commits.
                  const input = (e.currentTarget as HTMLDivElement).querySelector('input');
                  if (!input) return;
                  // Only focus+select when the tap lands on the written text,
                  // not the blank space after it. (Empty/placeholder text →
                  // always focus, since there's no text to aim at.) Either
                  // way the card still expands via the bubbled parent click.
                  const text = segment.text;
                  if (text.trim() !== '') {
                    const rect = input.getBoundingClientRect();
                    // 12 = input's left padding (see style below).
                    const textEndX = rect.left + 12
                      + measureTextWidth(text, '600 17px Inter, -apple-system, sans-serif');
                    if (e.clientX > textEndX + 4) return; // tapped blank space
                  }
                  input.readOnly = false;
                  input.focus();
                  input.select();
                }}
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
                        // Also bumped up by at least 1 if ANY segment has a
                        // fractional weight — so the percentages reflect
                        // the precision the user actually entered.
                        const total = state.segments.reduce((s, x) => s + x.weight, 0);
                        const pct = total > 0 ? (segment.weight / total) * 100 : 0;
                        const hasFractionalWeight = state.segments.some(s => s.weight !== Math.floor(s.weight));
                        const baseDecimals = state.segments.length > 21 ? 2 : state.segments.length > 10 ? 1 : 0;
                        const decimals = Math.max(baseDecimals, hasFractionalWeight ? 1 : 0);
                        return `${pct.toFixed(decimals)}%`;
                      })()}
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <PushDownButton
                      color={'#F8F8F9'}
                      innerStrokeColor={'#E5E5E5'}
                      innerStrokeWidth={3}
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
                    {/* Custom slider — track + absolutely-positioned
                        thumb, no <input type="range">. The thumb is a
                        regular div so its left/right edges can extend
                        past the slot at min/max (12.5px = halfThumb +
                        halo) without fighting the browser's locked
                        thumb-position rules. The slot itself captures
                        pointer events for drag-to-change. */}
                    {(() => {
                      const surfaces = deriveCardSurfaces(segment.color);
                      const top = segment.color;
                      const bot = surfaces.bottom;
                      const stroke = surfaces.innerStroke;
                      const pillColor = oklchShadow(top, 0.05, 1.2);
                      // Piecewise weight↔position mapping. The slider's
                      // value range (0.1–10) is unchanged, but its
                      // VISUAL distribution is split so the balanced
                      // position (weight=1) sits at the 1/4 mark of
                      // the track. Below balanced (0.1–1) gets the
                      // left 25% of the track (looser scale);
                      // above balanced (1–10) gets the right 75%.
                      const weightToFrac = (w: number) => {
                        if (w <= 1) return Math.max(0, (w - 0.1) / 0.9) * 0.25;
                        return 0.25 + Math.min(1, (w - 1) / 9) * 0.75;
                      };
                      const fracToWeight = (f: number) => {
                        if (f <= 0.25) return 0.1 + (f / 0.25) * 0.9;
                        return 1 + ((f - 0.25) / 0.75) * 9;
                      };
                      const percentFrac = Math.max(0, Math.min(1, weightToFrac(segment.weight)));
                      const percent = percentFrac * 100;
                      // Snap detent at the balanced weight (1), which the
                      // piecewise mapping places at the 1/4 mark.
                      const SNAP_FRAC = 0.25;
                      const SNAP_THRESHOLD = 0.035;
                      const updateFromPointer = (e: React.PointerEvent<HTMLDivElement>) => {
                        const rect = e.currentTarget.getBoundingClientRect();
                        const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                        const weight = Math.abs(fraction - SNAP_FRAC) < SNAP_THRESHOLD
                          ? 1
                          : fracToWeight(fraction);
                        patchSegment(index, { weight });
                      };
                      return (
                        <div
                          style={{
                            flex: 1,
                            position: 'relative',
                            height: 44,
                            touchAction: 'none',
                            userSelect: 'none',
                          }}
                          onPointerDown={e => {
                            e.stopPropagation();
                            e.currentTarget.setPointerCapture(e.pointerId);
                            setWeightThumbDrag(true);
                            updateFromPointer(e);
                          }}
                          onPointerMove={e => {
                            if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
                            updateFromPointer(e);
                          }}
                          onPointerUp={e => {
                            if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                              e.currentTarget.releasePointerCapture(e.pointerId);
                            }
                            setWeightThumbDrag(false);
                            commit();
                          }}
                          onPointerCancel={() => setWeightThumbDrag(false)}
                        >
                          {/* Track — filled with segment color up to the
                              current percent, grey beyond, same halo
                              recipe as the thumb / +/- buttons. */}
                          <div style={{
                            position: 'absolute',
                            left: 8,
                            right: 8,
                            top: '50%',
                            transform: 'translateY(calc(-50% + 3px))',
                            height: 6,
                            borderRadius: 4,
                            background: `linear-gradient(to right, ${top} 0%, ${top} ${percent}%, #C4C4C4 ${percent}%, #C4C4C4 100%)`,
                            boxShadow: '0 0 0 3.5px #00000012',
                            pointerEvents: 'none',
                          }} />
                          {/* Snap detent — two vertical pills above/below the
                              track at the balanced-weight (1) position. */}
                          {[-1, 1].map(dir => (
                            <div key={dir} style={{
                              position: 'absolute',
                              left: `calc(${SNAP_FRAC} * (100% - 28px) + 14px)`,
                              top: `calc(50% + 3px + ${dir * 13}px)`,
                              transform: 'translate(-50%, -50%)',
                              width: 4,
                              height: 9,
                              borderRadius: 2,
                              backgroundColor: 'rgba(0,0,0,0.18)',
                              pointerEvents: 'none',
                            }} />
                          ))}
                          {/* Thumb — `left` formula maps percent ∈ [0,1]
                              into [4, slot-26] so the thumb stays
                              4px inside the slot at min/max (slight
                              inset). */}
                          <div style={{
                            position: 'absolute',
                            left: `calc(${percentFrac} * (100% - 28px) + 4px)`,
                            top: '50%',
                            transform: `translateY(-50%) scale(${weightThumbDrag ? 1.18 : 1})`,
                            transformOrigin: 'center',
                            transition: 'transform 0.15s ease',
                            width: 20,
                            height: 44,
                            pointerEvents: 'none',
                          }}>
                            {/* Bottom layer (peek) — 5px shorter from
                                the top of the thumb so the top face
                                hangs over it; halo wraps just this. */}
                            <div style={{
                              position: 'absolute',
                              top: 5,
                              left: 0,
                              right: 0,
                              bottom: 0,
                              borderRadius: 5,
                              backgroundColor: bot,
                              boxShadow: '0 0 0 3.5px #00000012',
                            }} />
                            {/* Top face — colored fill + 3px inner
                                stroke (border), two grip pills centered
                                via flex. */}
                            <div style={{
                              position: 'absolute',
                              top: 0,
                              left: 0,
                              width: 20,
                              height: 39,
                              borderRadius: 5,
                              backgroundColor: top,
                              border: `3px solid ${stroke}`,
                              boxSizing: 'border-box',
                              display: 'flex',
                              justifyContent: 'center',
                              alignItems: 'center',
                              gap: 2,
                            }}>
                              <div style={{ width: 3, height: 26, borderRadius: 1.5, backgroundColor: pillColor }} />
                              <div style={{ width: 3, height: 26, borderRadius: 1.5, backgroundColor: pillColor }} />
                            </div>
                          </div>
                        </div>
                      );
                    })()}
                    <PushDownButton
                      color={'#F8F8F9'}
                      innerStrokeColor={'#E5E5E5'}
                      innerStrokeWidth={3}
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
              boxShadow: `0 0 0 3.5px rgba(0, 0, 0, 0.36)`,
              pointerEvents: 'none',
            }}
          />
        }
        openTrailingTrigger={autoOpenSpec.id === segment.id ? autoOpenSpec.tick : 0}
        trailingActions={[
          {
            // Grey "more" button — opens the full segment actions sheet
            // (same one the long-press-without-drag opens).
            color: '#38383E',
            icon: <MoreHorizontal size={26} />,
            onTap: () => setSegmentActionsIndex(index),
          },
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

  // Fill the sheet: size the textarea from the sheet's current height
  // (minus the chrome above/below it — handle, mode toggle, hint, paddings)
  // so it GROWS when the sheet is dragged to a taller snap. Floored at the
  // midSnap fill height so it never shrinks below its midSnap size as the
  // sheet is dragged down toward/below midSnap — grow-only. Falls back to a
  // fixed height when there's no sheet (desktop sidebar).
  const LIST_CHROME = 146;
  const MIDSNAP_FILL = 400 - LIST_CHROME; // sheet opens at the fixed 400px midSnap
  const listTextareaHeight = sheetHeight && sheetHeight > 0
    ? Math.max(MIDSNAP_FILL, Math.round(sheetHeight - LIST_CHROME))
    : 244;
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
        style={{
          width: '100%',
          height: listTextareaHeight,
          padding: '14px 16px',
          borderRadius: 14,
          border: `1.5px solid ${BORDER}`,
          backgroundColor: SURFACE_ELEVATED,
          fontSize: 16,
          fontWeight: 500,
          fontFamily: 'inherit',
          color: ON_SURFACE,
          outline: 'none',
          // Sized to the sheet (see listTextareaHeight) and scrolls
          // internally for long lists instead of pushing itself past the
          // sheet's bottom edge. `resize:none` stops the user dragging the
          // grip handle to extend it past the sheet.
          resize: 'none',
          overflowY: 'auto',
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
  //
  // In-place reorganization of the (previously flat) 12-control list into four
  // labelled sections via <StyleSection>. Controls, primitives, and the
  // patch()/commit() wiring are untouched — only grouping chrome was added,
  // plus the two colour pickers moved into collapsible <ColorSwatchRow>s so
  // they don't eat the whole sheet. Row labels drop the now-redundant group
  // prefix (e.g. "Marker Diameter" → "Diameter" under the Center Marker
  // header).
  const renderStyleTab = () => (
    <div style={{ paddingTop: 16 }}>
      {/* ── Text & Images — everything overlaid on a wedge ──────────────── */}
      <StyleSection title="Text & Images" icon={<Type size={13} />} first>
        <SettingSlider label="Segment Text" value={state.textSize} min={0.1} max={1.9} step={0.05}
          snapPoint={1}
          onChange={v => patch({ textSize: v })} onChangeEnd={commit} />

        {/* Auto-fit (shrink-to-fit + middle "…") is always on. This just lets a
            long label wrap onto 2 lines when that renders larger. */}
        <SettingToggleRow
          icon={<WrapText size={20} />}
          label="Wrap (2 lines)"
          value={state.textWrap}
          onChange={v => set({ ...state, textWrap: v })}
        />

        {/* Header on/off + its size, co-located. The on/off was a separate
            Settings row that activated the header; without it the "Header
            Text" size slider did nothing. Now the size only appears once the
            header is on, so an off header leaves no dead control. When the
            host doesn't wire onToggleSegmentHeader (desktop/legacy), fall
            back to always showing the size. */}
        {onToggleSegmentHeader ? (
          <>
            <SettingToggleRow
              icon={<Heading size={20} />}
              label="Header"
              value={!!showSegmentHeader}
              onChange={onToggleSegmentHeader}
            />
            {showSegmentHeader && (
              <SettingSlider label="Header Text" value={state.headerTextSize} min={0.05} max={2} step={0.01}
                snapPoint={1}
                onChange={v => patch({ headerTextSize: v })} onChangeEnd={commit} />
            )}
          </>
        ) : (
          <SettingSlider label="Header Text" value={state.headerTextSize} min={0.05} max={2} step={0.01}
            snapPoint={1}
            onChange={v => patch({ headerTextSize: v })} onChangeEnd={commit} />
        )}

        <SettingSlider label="Image Size" value={state.imageSize} min={20} max={150} step={1}
          snapPoint={60}
          onChange={v => patch({ imageSize: v })} onChangeEnd={commit} />
      </StyleSection>

      {/* ── Segments — the wedge shape ──────────────────────────────────── */}
      <StyleSection title="Segments" icon={<PieChart size={13} />}>
        <SettingSlider label="Corner Radius" value={state.cornerRadius} min={0} max={100} step={2.5}
          snapPoint={30}
          onChange={v => patch({ cornerRadius: v })} onChangeEnd={commit} />

        {/* Inner corners — native select (a solid touch target on mobile),
            with the label restyled to match the slider rows above. */}
        <div style={{ display: 'flex', alignItems: 'center', padding: '4px', marginBottom: 12 }}>
          <span style={{ fontWeight: 700, fontSize: 14, color: ON_SURFACE }}>Inner Corners</span>
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

        {/* Center Inset only applies once the wedge has shaped inner corners
            — progressive disclosure, unchanged. */}
        {state.innerCornerStyle !== 'none' && (
          <SettingSlider label="Center Inset" value={state.centerInset} min={0} max={150} step={1.5}
            snapPoint={50}
            onChange={v => patch({ centerInset: v })} onChangeEnd={commit} />
        )}
      </StyleSection>

      {/* ── Wheel — the disc itself (stroke drives ring + dividers) ─────── */}
      <StyleSection title="Wheel" icon={<Disc size={13} />}>
        <SettingSlider label="Stroke Width" value={state.strokeWidth} min={0} max={20} step={0.1}
          snapPoint={7.7}
          onChange={v => patch({ strokeWidth: v })} onChangeEnd={commit} />
        {/* Extra outer border, independent of the divider stroke above. */}
        <SettingSlider label="Outer Stroke" value={state.outerStrokeWidth} min={0} max={30} step={0.1}
          onChange={v => patch({ outerStrokeWidth: v })} onChangeEnd={commit} />

        {/* Decorative bezel dots — unlocked only once the combined stroke band
            (divider + outer) is wide enough to host them. The two add up, so
            either slider alone can reach the threshold. */}
        {state.strokeWidth + state.outerStrokeWidth >= OUTER_DOTS_MIN_STROKE
          && (state.cornerRadius <= OUTER_DOTS_MAX_CORNER || state.showBackgroundCircle) && (
          <SettingToggleRow
            icon={<Circle size={20} />}
            label="Bezel Dots"
            value={state.outerStrokeDots}
            onChange={v => set({ ...state, outerStrokeDots: v })}
          />
        )}

        <SettingToggleRow
          icon={<Circle size={20} />}
          label="Background Circle"
          value={state.showBackgroundCircle}
          onChange={v => set({ ...state, showBackgroundCircle: v })}
        />

        {/* One base colour for the whole wheel chrome — dividers/ring +
            background circle here, and the centre marker below (which no
            longer has its own colour). */}
        <ColorSwatchRow
          label="Base Color"
          color={state.wheelBaseColor}
          onChange={c => patch({ wheelBaseColor: c })}
          onCommit={commit}
        />
      </StyleSection>

      {/* ── Center Marker — the pin ─────────────────────────────────────── */}
      <StyleSection title="Center Marker" icon={<MapPin size={13} />}>
        <SettingSlider label="Diameter" value={state.markerDiameter} min={10} max={90} step={1}
          snapPoint={50}
          onChange={v => patch({ markerDiameter: v })} onChangeEnd={commit} />
        <SettingSlider label="Peek" value={state.markerPeek} min={0} max={15} step={1}
          snapPoint={15}
          onChange={v => patch({ markerPeek: v })} onChangeEnd={commit} />
        {/* Colour lives in Wheel › Base Color — the marker shares it. */}
      </StyleSection>

      {/* ── Sound — the tick the wheel makes as it passes segments. The win
          arpeggio always plays regardless of this choice. ────────────────── */}
      <StyleSection title="Sound" icon={<Volume2 size={13} />}>
        <div style={{ display: 'flex', alignItems: 'center', padding: '4px' }}>
          <span style={{ fontWeight: 700, fontSize: 14, color: ON_SURFACE }}>Tick</span>
          <div style={{ flex: 1 }} />
          <select
            value={state.tickSound}
            onChange={e => set({ ...state, tickSound: e.target.value as EditorState['tickSound'] })}
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
            <option value="click">Click</option>
            <option value="blip">Blip</option>
            <option value="fire">Fire</option>
            <option value="ding">Bell</option>
            <option value="zap">Zap</option>
          </select>
        </div>
      </StyleSection>

      {/* ── Result — celebration screen shown when a spin lands ──────────── */}
      <StyleSection title="Result" icon={<PartyPopper size={13} />}>
        <SettingToggleRow
          icon={<PartyPopper size={20} />}
          label="Result screen + confetti"
          value={state.resultDialog}
          onChange={v => set({ ...state, resultDialog: v })}
        />
      </StyleSection>

      <div style={{ height: 32 }} />
    </div>
  );

  return (
    <div style={{ padding: '4px 20px 16px' }}>
      {/* Both tabs stay mounted in the DOM so tab switches (and the
          first chip-tap-open) don't have to remount the segment list —
          on a wheel with many segments, that remount is the bulk of
          the "segments sheet feels slower than style sheet" lag. The
          inactive tab is hidden with display:none (zero layout cost)
          but its React tree stays intact, so the next switch back is
          a single display flip. */}
      <div style={{ display: selectedTab === 1 ? 'block' : 'none' }}>
        {renderStyleTab()}
      </div>
      <div style={{ display: selectedTab === 0 ? 'block' : 'none' }}>
        <>
          <SegmentsModeToggle value={segmentsMode} onChange={setSegmentsMode} />
          {/* Heavy segment list is gated on renderRows: while the sheet is
              closed (renderRows=false) we render a cheap spacer instead of
              the N segment rows, so switching wheels costs nothing. The
              rows mount when the sheet opens. The spacer's height roughly
              approximates the list so the closed (invisible) layout isn't
              wildly off; exact value doesn't matter since it's not seen. */}
          {!renderRows ? (
            <div style={{ height: 120 }} />
          ) : segmentsMode === 'list' ? renderSimpleMode() : (
            <div ref={listContainerRef} style={{ marginLeft: -12, marginRight: -12, position: 'relative' }}>
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
                    const i = indexFromClientY(e.clientY);
                    if (i != null) handleGripPointerDown(i, e);
                  }}
                  onClick={(e) => {
                    const i = indexFromClientY(e.clientY);
                    if (i != null) setExpandedIndex(i);
                  }}
                />
              )}
              {(() => {
                // Spacer virtualization: render only the rows in the current
                // window as full cards; replace the off-window rows above and
                // below with a single sized spacer each. Drag positions are
                // arithmetic (uniform rowH), so off-window rows don't need to
                // exist in the DOM — that's what makes both open and reorder
                // O(visible) instead of O(N).
                //
                // Virtualization stays ON even while a card is expanded —
                // that's what keeps expand/collapse cheap (it just swaps the
                // already-rendered window row to its tall content instead of
                // mounting all N rows). The expanded card sits in the rendered
                // window (you tapped a visible row), so flow handles its extra
                // height; the SEG_WINDOW_BUFFER absorbs the resulting small
                // offset in the uniform window math. We extend the window to
                // always include the expanded index in case it gets scrolled
                // toward the edge, so its tall content never falls into a
                // (collapsed-height) spacer.
                const total = segments.length;
                const rowH = rowHeightRef.current;
                const virtualize = WINDOW_SEGMENTS;
                let start = virtualize ? Math.max(0, segWindow.start) : 0;
                let end = virtualize ? Math.min(total - 1, segWindow.end) : total - 1;
                if (virtualize && expandedIndex != null) {
                  start = Math.min(start, expandedIndex);
                  end = Math.max(end, expandedIndex);
                }
                const out: React.ReactNode[] = [];
                if (virtualize && start > 0) {
                  out.push(<div key="seg-spacer-top" style={{ height: start * rowH }} />);
                }
                for (let i = start; i <= end; i++) {
                  const seg = segments[i];
                  if (!seg) continue;
                  // Just-deleted rows vanish immediately (the wheel plays the
                  // shrink animation); their slot collapses.
                  if (pendingDeleteIds.has(seg.id)) continue;
                  const isGrabbed = grabbedIndex === i;
                  // Grabbed row reads the live offset ref so an occasional
                  // (drop-target-change) re-render places it where the
                  // imperative per-frame updates have it.
                  const slotOffset = isGrabbed ? dragOffsetRef.current : computeSlotOffset(i);
                  const grabbedNotSettling = isGrabbed && !isSettling;
                  const transition = (grabbedNotSettling || isCommitting)
                    ? 'transform 0s, box-shadow 0.12s ease'
                    : 'transform 0.22s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.12s ease';
                  const transform = isGrabbed
                    ? `translateY(${slotOffset}px) scale(1.04)`
                    : `translateY(${slotOffset}px) scale(1)`;
                  out.push(
                    <SegmentRow
                      key={seg.id}
                      innerRef={el => { segmentElsRef.current[i] = el; }}
                      index={i}
                      isGrabbed={isGrabbed}
                      transform={transform}
                      transition={transition}
                      // Long-press is gated to the collapsed state — when the
                      // card is open, all the inner controls (color picker,
                      // weight buttons, text input) need raw pointer access.
                      onLongPressActivate={expandedIndex === i ? undefined : handleGrabStart}
                    >
                      {renderSegmentCard(seg, i)}
                    </SegmentRow>
                  );
                }
                if (virtualize && end < total - 1) {
                  out.push(<div key="seg-spacer-bottom" style={{ height: (total - 1 - end) * rowH }} />);
                }
                return out;
              })()}
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
      </div>
      {/* Segment actions — opened by a long-press that releases without any
          drag. Same DraggableSheet shell + row styling as the wheel actions
          sheet so the two read as a set. */}
      {segmentActionsIndex !== null && (
        <DraggableSheet maxWidth={9999} onClose={() => setSegmentActionsIndex(null)}>
          <div style={{ padding: '0 20px 28px' }}>
            <h3 style={{ fontSize: 18, fontWeight: 800, textAlign: 'center', margin: '0 0 16px' }}>
              Segment actions
            </h3>
            <SegActionRow
              icon={<Copy size={20} />}
              label="Copy segment"
              onTap={() => { const i = segmentActionsIndex; setSegmentActionsIndex(null); copySegment(i); }}
            />
            {canPasteSegment && (
              <SegActionRow
                icon={<ClipboardPaste size={20} />}
                label="Paste segment"
                onTap={() => { const i = segmentActionsIndex; setSegmentActionsIndex(null); pasteSegment(i); }}
              />
            )}
            <SegActionRow
              icon={<CopyPlus size={20} />}
              label="Duplicate segment"
              onTap={() => { const i = segmentActionsIndex; setSegmentActionsIndex(null); duplicateSegment(i); }}
            />
            <SegActionRow
              icon={<Trash2 size={20} />}
              label="Delete segment"
              danger
              onTap={() => { const i = segmentActionsIndex; setSegmentActionsIndex(null); removeSegment(i); }}
            />
          </div>
        </DraggableSheet>
      )}
    </div>
  );
}

// Row in the segment actions sheet — mirrors RouletteScreen's CtxRow so the
// segment sheet looks identical to the wheel actions sheet.
function SegActionRow({ icon, label, onTap, danger }: {
  icon: ReactNode;
  label: string;
  onTap: () => void;
  danger?: boolean;
}) {
  const contentColor = danger ? '#EF4444' : ON_SURFACE;
  return (
    <PushDownButton
      onTap={onTap}
      color={SURFACE_ELEVATED}
      borderRadius={16}
      height={54}
      bottomBorderWidth={4}
      innerStrokeWidth={3}
      style={{ marginBottom: 5 }}
    >
      <div style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 14, paddingLeft: 16, color: contentColor }}>
        {icon}
        <span style={{ fontWeight: 700, fontSize: 15 }}>{label}</span>
      </div>
    </PushDownButton>
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
  index, isGrabbed, transform, transition, onLongPressActivate, innerRef, children,
}: {
  index: number;
  isGrabbed: boolean;
  transform: string;
  transition: string;
  onLongPressActivate?: (index: number, startX: number, startY: number) => void;
  innerRef?: (el: HTMLDivElement | null) => void;
  children: React.ReactNode;
}) {
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startPosRef = useRef<{ x: number; y: number } | null>(null);
  const capturedRef = useRef<{ target: Element; pointerId: number } | null>(null);
  const didLongPressRef = useRef(false);
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
    // Always overwrite (not just-when-null) — after a drag-reorder the
    // long-press path releases pointer capture before pointerup fires,
    // so onPointerUp/Cancel never runs and `startPosRef` stays stale.
    // Without this, the next tap would compute dx/dy from the OLD drag
    // start, flip didMoveRef true, and silently swallow the click.
    startPosRef.current = { x: e.clientX, y: e.clientY };
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
      ref={innerRef}
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
        marginBottom: 9,
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
        // Skip layout + paint for off-screen rows. With a long segment
        // list this is the difference between the browser laying out N
        // cards on sheet-open (laggy) vs only the ~5 that fit in the
        // sheet viewport. `contain-intrinsic-size` is the assumed
        // height while the element is skipped — set conservatively to
        // the typical collapsed card height so scrollbar sizing /
        // scroll-anchoring stay reasonable. Disabled while the row is
        // being drag-reordered (the transform can carry it past the
        // viewport edge and we want it rendered the whole time).
        contentVisibility: isGrabbed ? 'visible' : 'auto',
        containIntrinsicSize: 'auto 80px',
      }}
    >
      {/* Halo is rendered INSIDE the SwipeableActionCell now (via its
          `halo` prop) so it z-stacks above the action buttons but below
          the card's translate layer. See SwipeableActionCell for the
          structural reasoning. */}
      {children}
    </div>
  );
}

// Lock the parent scroll container while a row is being dragged. Walks up
// from the grabbed row and freezes overflow + touch-action on every
// scrollable ancestor, restoring on release. Same recipe as BlocksList.

// ── Setting Slider ────────────────────────────────────────────────────────

// Styled like the expanded segment card's Weight control: a label + value
// header row above a [−] · slider · [+] row, with a custom 3D thumb on a
// gradient track (no native <input type="range">). Themed for the dark
// style sheet using PRIMARY as the accent; the mapping is linear (the
// weight control's piecewise curve is specific to weights).
// ── Style-tab section header ─────────────────────────────────────────────
// Muted, letter-spaced label (with a leading icon) that groups the otherwise
// flat Style controls into labelled sections — Text & Images / Segments /
// Wheel / Center Marker. Pure layout chrome: same tokens, radii, and weights
// as everything else, so it reads as part of the existing design language.
// `first` drops the leading divider + top spacing so the first section hugs
// the top of the sheet.
function StyleSection({ title, icon, first, children }: {
  title: string;
  icon?: ReactNode;
  first?: boolean;
  children: ReactNode;
}) {
  return (
    <div style={{
      marginTop: first ? 0 : 22,
      paddingTop: first ? 0 : 20,
      borderTop: first ? undefined : `1px solid ${withAlpha(BORDER, 0.6)}`,
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        marginBottom: 14,
        color: withAlpha(ON_SURFACE, 0.4),
      }}>
        {icon && <span style={{ display: 'flex' }}>{icon}</span>}
        <span style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: 1,
          textTransform: 'uppercase',
        }}>
          {title}
        </span>
      </div>
      {children}
    </div>
  );
}

// ── Toggle row — icon + label + pill switch ──────────────────────────────
// Mirrors the Settings tab's ToggleRow so on/off controls read identically
// across the editor (the Style tab previously had a one-off CheckCircle card).
// Used for Background Circle and the Header toggle.
function SettingToggleRow({ icon, label, value, onChange }: {
  icon?: ReactNode;
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div
      onClick={() => onChange(!value)}
      style={{
        display: 'flex',
        alignItems: 'center',
        padding: '12px 16px',
        borderRadius: 14,
        backgroundColor: value ? withAlpha(PRIMARY, 0.12) : SURFACE_ELEVATED,
        border: `1.5px solid ${value ? PRIMARY : BORDER}`,
        cursor: 'pointer',
        transition: 'all 0.18s',
        marginBottom: 12,
      }}
    >
      {icon && (
        <span style={{ display: 'flex', color: value ? PRIMARY : withAlpha(ON_SURFACE, 0.45) }}>
          {icon}
        </span>
      )}
      <span style={{
        flex: 1,
        marginLeft: icon ? 12 : 0,
        fontWeight: 600,
        fontSize: 15,
        color: value ? ON_SURFACE : withAlpha(ON_SURFACE, 0.5),
      }}>
        {label}
      </span>
      <div style={{
        width: 44,
        height: 26,
        borderRadius: 13,
        backgroundColor: value ? PRIMARY : BORDER,
        display: 'flex',
        alignItems: 'center',
        padding: 2,
        justifyContent: value ? 'flex-end' : 'flex-start',
        transition: 'all 0.18s',
        flexShrink: 0,
      }}>
        <div style={{ width: 22, height: 22, borderRadius: '50%', backgroundColor: '#FFFFFF' }} />
      </div>
    </div>
  );
}

// ── Collapsible colour swatch row ────────────────────────────────────────
// Replaces an always-open HexColorPicker (~200px tall) with a compact
// swatch + hex row that expands the picker inline on tap — so two colour
// controls don't swallow most of the sheet. Preserves the picker's existing
// contract: its own drags stopPropagation (so the sheet doesn't read them as
// scroll-to-drag) and one undo entry commits on pointer release.
function ColorSwatchRow({ label, color, onChange, onCommit }: {
  label: string;
  color: string;
  onChange: (c: string) => void;
  onCommit: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginBottom: 12 }}>
      <div
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '10px 14px',
          borderRadius: 14,
          backgroundColor: SURFACE_ELEVATED,
          border: `1.5px solid ${open ? withAlpha(PRIMARY, 0.6) : BORDER}`,
          cursor: 'pointer',
          transition: 'border-color 0.18s',
        }}
      >
        {/* Live swatch — dark ring + faint inner highlight so both light and
            dark fills still read as a raised chip. */}
        <div style={{
          width: 26,
          height: 26,
          borderRadius: 8,
          backgroundColor: color,
          border: `2px solid ${withAlpha(BG, 0.55)}`,
          boxShadow: `inset 0 0 0 1px ${withAlpha('#ffffff', 0.08)}`,
          flexShrink: 0,
        }} />
        <span style={{ marginLeft: 12, flex: 1, fontWeight: 700, fontSize: 14, color: ON_SURFACE }}>
          {label}
        </span>
        <span style={{
          marginRight: 10,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: 13,
          fontWeight: 600,
          letterSpacing: 0.3,
          color: withAlpha(ON_SURFACE, 0.5),
          textTransform: 'uppercase',
        }}>
          {color}
        </span>
        <ChevronDown
          size={18}
          color={withAlpha(ON_SURFACE, 0.5)}
          style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s ease' }}
        />
      </div>

      {open && (
        <div
          style={{ marginTop: 10 }}
          // Keep the picker's own drags from bubbling to the sheet's
          // scroll-to-drag handler; commit one undo entry on release.
          onPointerDown={e => e.stopPropagation()}
          onMouseDown={e => e.stopPropagation()}
          onTouchStart={e => e.stopPropagation()}
          onPointerUp={onCommit}
        >
          <HexColorPicker color={color} onChange={onChange} style={{ width: '100%' }} />
        </div>
      )}
    </div>
  );
}

function SettingSlider({ label, value, min, max, step, onChange, onChangeEnd, snapPoint }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  onChangeEnd?: () => void;
  // Default ("home") value. When the dragged thumb gets within
  // SNAP_THRESHOLD of it, the value snaps exactly to it (a detent), and
  // two dots are drawn above/below the track at its position so the user
  // can see and return to the default.
  snapPoint?: number;
}) {
  const surfaces = deriveCardSurfaces(PRIMARY);
  const top = PRIMARY;
  const bot = surfaces.bottom;
  const stroke = surfaces.innerStroke;
  const pillColor = oklchShadow(PRIMARY, 0.05, 1.2);
  // Shared depth tones so the track, thumb halo, and step buttons match.
  const HALO = 'rgba(0,0,0,0.22)';        // recessed-ring shadow (track + thumb + buttons)
  const DARK_FACE = oklchShadow(BG, 0.03); // unfilled track + button bottom (shadow) face
  const span = max - min || 1;
  const frac = Math.max(0, Math.min(1, (value - min) / span));
  const percent = frac * 100;
  const display = max > 10 ? value.toFixed(0) : value.toFixed(1);
  // Fraction along the track where the snap detent sits (clamped on-track).
  const snapFrac = snapPoint != null
    ? Math.max(0, Math.min(1, (snapPoint - min) / span))
    : null;
  const SNAP_THRESHOLD = 0.035; // ~3.5% of the track width
  // Thumb grows only while being directly touched/dragged, eases back on
  // release. (No grow/glide tied to the +/- buttons.)
  const [thumbDrag, setThumbDrag] = useState(false);

  const updateFromPointer = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    // Snap to the default when the thumb is dragged close to it.
    if (snapFrac != null && Math.abs(f - snapFrac) < SNAP_THRESHOLD && snapPoint != null) {
      onChange(snapPoint);
      return;
    }
    onChange(min + f * span);
  };

  // Shared button styling for [−] / [+] — dark face lifted from the sheet.
  const stepBtnProps = {
    color: SURFACE_ELEVATED,
    innerStrokeColor: BORDER,
    innerStrokeWidth: 3,
    // Bottom (shadow) face — a touch darker than BG for a deeper 3D edge.
    bottomBorderColor: DARK_FACE,
    // Match the track's halo so the buttons read as the same depth instead
    // of the faint derived ring.
    haloColor: HALO,
    borderRadius: 10,
    height: 44,
    bottomBorderWidth: 5,
    repeatHold: { delayMs: 700, intervalMs: 150, maxIntervalMs: 50, rampMs: 900 },
    style: { width: 39 },
  } as const;
  const stepIcon = (pressed: boolean, kind: 'minus' | 'plus') => (
    kind === 'minus'
      ? <Minus size={22} color={withAlpha(ON_SURFACE, pressed ? 0.95 : 0.65)} strokeWidth={3} />
      : <Plus size={22} color={withAlpha(ON_SURFACE, pressed ? 0.95 : 0.65)} strokeWidth={3} />
  );

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 8,
      }}>
        <span style={{ fontWeight: 700, fontSize: 14, color: ON_SURFACE }}>{label}</span>
        <span style={{ fontWeight: 700, fontSize: 14, color: ON_SURFACE }}>{display}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <PushDownButton
          {...stepBtnProps}
          onTap={() => { onChange(Math.max(min, value - step)); onChangeEnd?.(); }}
        >
          {(pressed: boolean) => stepIcon(pressed, 'minus')}
        </PushDownButton>

        <div
          style={{ flex: 1, position: 'relative', height: 44, touchAction: 'none', userSelect: 'none' }}
          onPointerDown={e => {
            e.stopPropagation();
            e.currentTarget.setPointerCapture(e.pointerId);
            setThumbDrag(true);
            updateFromPointer(e);
          }}
          onPointerMove={e => {
            if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
            updateFromPointer(e);
          }}
          onPointerUp={e => {
            if (e.currentTarget.hasPointerCapture(e.pointerId)) {
              e.currentTarget.releasePointerCapture(e.pointerId);
            }
            setThumbDrag(false);
            onChangeEnd?.();
          }}
          onPointerCancel={() => setThumbDrag(false)}
        >
          {/* Track — PRIMARY fill up to percent, muted grey beyond. */}
          <div style={{
            position: 'absolute',
            left: 8,
            right: 8,
            top: '50%',
            transform: 'translateY(calc(-50% + 3px))',
            height: 6,
            borderRadius: 4,
            background: `linear-gradient(to right, ${top} 0%, ${top} ${percent}%, ${DARK_FACE} ${percent}%, ${DARK_FACE} 100%)`,
            // Recessed-track halo, matching the thumb + step buttons.
            boxShadow: `0 0 0 3.5px ${HALO}`,
            pointerEvents: 'none',
          }} />
          {/* Snap detent — two dots above and below the track at the
              default value's position, marking the "home" the thumb
              snaps to. Hidden behind the thumb when it's parked there. */}
          {snapFrac != null && [-1, 1].map(dir => (
            <div key={dir} style={{
              position: 'absolute',
              left: `calc(${snapFrac} * (100% - 28px) + 14px)`,
              top: `calc(50% + 3px + ${dir * 13}px)`,
              transform: 'translate(-50%, -50%)',
              width: 4,
              height: 9,
              borderRadius: 2,
              backgroundColor: 'rgba(0,0,0,0.18)',
              pointerEvents: 'none',
            }} />
          ))}
          {/* 3D thumb — bottom peek + colored top face with two grip pills.
              Grows while directly touched/dragged. */}
          <div style={{
            position: 'absolute',
            left: `calc(${frac} * (100% - 28px) + 4px)`,
            top: '50%',
            transform: `translateY(-50%) scale(${thumbDrag ? 1.18 : 1})`,
            transformOrigin: 'center',
            transition: 'transform 0.15s ease',
            width: 20,
            height: 44,
            pointerEvents: 'none',
          }}>
            <div style={{
              position: 'absolute',
              top: 5, left: 0, right: 0, bottom: 0,
              borderRadius: 5,
              backgroundColor: bot,
              // Same halo as the track + step buttons.
              boxShadow: `0 0 0 3.5px ${HALO}`,
            }} />
            <div style={{
              position: 'absolute',
              top: 0, left: 0,
              width: 20, height: 39,
              borderRadius: 5,
              backgroundColor: top,
              border: `3px solid ${stroke}`,
              boxSizing: 'border-box',
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              gap: 2,
            }}>
              <div style={{ width: 3, height: 26, borderRadius: 1.5, backgroundColor: pillColor }} />
              <div style={{ width: 3, height: 26, borderRadius: 1.5, backgroundColor: pillColor }} />
            </div>
          </div>
        </div>

        <PushDownButton
          {...stepBtnProps}
          onTap={() => { onChange(Math.min(max, value + step)); onChangeEnd?.(); }}
        >
          {(pressed: boolean) => stepIcon(pressed, 'plus')}
        </PushDownButton>
      </div>
    </div>
  );
}
