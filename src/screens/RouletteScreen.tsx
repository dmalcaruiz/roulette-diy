import { useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Block, WheelConfig } from '../models/types';
import SpinningWheel, { SpinningWheelHandle } from '../components/SpinningWheel';
import WheelEditor, { buildInitialState, EditorState, stateToConfig } from '../components/WheelEditor';
import { PushDownButton } from '../components/PushDownButton';
import { withAlpha, deriveCardSurfaces } from '../utils/colorUtils';
import { ON_SURFACE, PRIMARY, BORDER, BG, SURFACE, SURFACE_ELEVATED } from '../utils/constants';
import { ArrowLeft, Shuffle, Sparkles, Play, Square, X, Undo2, Redo2, Plus, Paintbrush, Settings as SettingsIcon, LayoutGrid, Trash2, Copy, CopyPlus, ClipboardPaste, Pencil, Share2, ChevronLeft, ChevronRight } from 'lucide-react';
import DraggableSheet from '../components/DraggableSheet';
import SnappingSheet from '../components/SnappingSheet';
import { isAnyCellSwipeDragActive } from '../components/SwipeableActionCell';
import { useHistory } from '../hooks/useHistory';
import WheelThumbnail from '../components/WheelThumbnail';
import { useAuth } from '../contexts/AuthContext';
import {
  buildAppendWheelChange, buildInsertWheelChange, buildDuplicateWheelChange,
  buildRemoveWheelChange,
} from '../services/flowService';
import { deleteDraft, saveDraft, type CloudBlock } from '../services/blockService';
import { dbg, sid, sids } from '../utils/debugLog';
import { recolorWithVibe, activeVibe, matchedVibe, firstOrderedVibe, rememberSelectedVibe } from '../components/editor/vibes';
import { SettingsPane } from '../components/editor/SettingsPane';
import { TemplatesPane } from '../components/editor/TemplatesPane';
import { useScrollSpy } from '../hooks/useScrollSpy';

// The four editor sections, top-to-bottom in the continuous sheet (= chip
// order). The scroll-spy highlights whichever section is in view.
const SECTION_KEYS = ['templates', 'segments', 'style', 'settings'] as const;
type Section = (typeof SECTION_KEYS)[number];

interface RouletteScreenProps {
  block: Block;
  editMode?: boolean;
  onBlockUpdated?: (block: Block) => void;
  // Optimistic delete callback — host (App) drops the id from its blocks
  // state immediately and persists in the background. Used for flow ops
  // (deleting a step / unwrapping the parent Experience when its last
  // step goes) so the profile / list views update this frame.
  onBlockDelete?: (id: string) => void;
  // Opens the publish/settings overlay. Called from the app bar's right-side
  // icon. When omitted, the icon is hidden.
  onRequestPublish?: () => void;
  // When this block is part of an Experience flow, the loaded step blocks
  // in order. The first entry is step 0; the block being edited is one of
  // these. If absent, the preview row shows just the current wheel.
  flowSteps?: CloudBlock[];
  // The parent Experience block itself, needed so the `+` handler can append
  // a step synchronously without an extra Firestore read.
  flowExperience?: CloudBlock;
  // Optimistic local update of the flow — called by the `+` handler so the
  // host (BlockScreen) can refresh the preview row without navigating. Also
  // called on rollback with the previous values if persistence fails.
  onFlowChange?: (experience: CloudBlock | undefined, steps: CloudBlock[]) => void;
  // Switch the active wheel locally without going through React Router.
  // BlockScreen swaps its `block` state in place — saves a render-pipeline
  // round-trip vs `navigate()`. The URL stays at the entry block; tile
  // switching is treated as session-local UI state, not a navigation.
  onSwitchActive?: (block: CloudBlock) => void;
}

// ── Wheel clipboard ───────────────────────────────────────────────────────
// Copy/Paste of a whole wheel persists through localStorage so it survives
// navigating between wheels/flows (each navigation remounts RouletteScreen)
// and page reloads. JSON round-tripping doubles as a deep clone, so later
// edits to the copied wheel never mutate what's on the clipboard.
const WHEEL_CLIPBOARD_KEY = 'roulette:wheelClipboard';
// Paste is only offered for this long after the Copy press — see the
// freshness check at the Paste row. Past it, Paste hides even with valid data.
const PASTE_TTL_MS = 3 * 60 * 1000;

interface WheelClipboard {
  config: WheelConfig;
  copiedAt: number; // epoch ms of the Copy press, for the TTL above
}
// A clipboard payload only counts as pasteable if it's structurally a wheel
// (an object with a non-empty `items` array) stamped with a copiedAt time.
// Guards against stale/garbage localStorage — without it, Paste could be
// offered for unpasteable data.
function isValidWheelConfig(v: unknown): v is WheelConfig {
  return !!v && typeof v === 'object'
    && Array.isArray((v as { items?: unknown }).items)
    && (v as { items: unknown[] }).items.length > 0;
}
function readWheelClipboard(): WheelClipboard | null {
  try {
    const raw = localStorage.getItem(WHEEL_CLIPBOARD_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { config?: unknown; copiedAt?: unknown };
    if (parsed && isValidWheelConfig(parsed.config) && typeof parsed.copiedAt === 'number') {
      return { config: parsed.config, copiedAt: parsed.copiedAt };
    }
    // Stale / malformed payload — drop it so Paste stays hidden.
    localStorage.removeItem(WHEEL_CLIPBOARD_KEY);
    return null;
  } catch {
    return null;
  }
}
function writeWheelClipboard(config: WheelConfig): void {
  try {
    localStorage.setItem(WHEEL_CLIPBOARD_KEY, JSON.stringify({ config, copiedAt: Date.now() }));
  } catch {
    /* storage unavailable / quota — copy silently no-ops */
  }
}

export default function RouletteScreen({
  block, editMode = false, onBlockUpdated, onBlockDelete, onRequestPublish,
  flowSteps, flowExperience, onFlowChange, onSwitchActive,
}: RouletteScreenProps) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  // Wheel-switch slide direction. Initial mount reads from navigation state
  // (so a deep-link or +-add can opt into a slide). Subsequent tile taps use
  // local state — switching is now session-local (no navigate), so the
  // direction needs somewhere to live that survives the in-place block swap.
  const initialWheelTransition = (location.state as { wheelTransition?: 'left' | 'right' } | null)?.wheelTransition;
  const [wheelTransition, setWheelTransition] = useState<'left' | 'right' | undefined>(initialWheelTransition);
  const wheelRef = useRef<SpinningWheelHandle>(null);
  const [backgroundColor, setBackgroundColor] = useState('#000000');
  const [textColor, setTextColor] = useState('#FFFFFF');
  const [overlayColor, setOverlayColor] = useState('#000000');
  // previewConfig holds in-progress edits so the wheel updates live during editing,
  // before the debounced auto-save flushes them back into block.wheelConfig.
  // We deliberately do NOT store a mirror of block.wheelConfig in state — deriving
  // activeConfig directly from the prop ensures no lag when the block changes,
  // which avoids the "new wheel flashes with old wheel's preview" bug.
  const [previewConfig, setPreviewConfig] = useState<WheelConfig | null>(null);
  const [isEditMode, setIsEditMode] = useState(editMode);
  const [spinIntensity, setSpinIntensity] = useState(0.5);
  const [isRandomIntensity, setIsRandomIntensity] = useState(true);
  const [showWinAnimation, setShowWinAnimation] = useState(true);
  const [showSegmentHeader, setShowSegmentHeader] = useState(false);
  const [showSpinButton, setShowSpinButton] = useState(false);
  // When the X is pressed we set this to true to play the slide-out-down
  // animation before actually navigating. The screen unmounts after the
  // animation finishes so the user sees the editor slide off the bottom.
  const [isClosing, setIsClosing] = useState(false);
  // Inner editor sheet starts closed. The user reveals it by tapping a chip
  // (Segments / Style / Settings) in the red footer. This keeps the overlay's
  // opening uncluttered — you see the wheel first, then choose to edit.
  // Continuous scroll-spy sheet — all four sections stack in one scroll column
  // inside the SnappingSheet. `sheetOpen` is the visibility flag; the scroll-spy
  // reports `currentSection` (the chip highlight); tapping a chip scrolls to it.
  const [sheetOpen, setSheetOpen] = useState(false);
  const [currentSection, setCurrentSection] = useState<Section>('segments');
  const spy = useScrollSpy<Section>(SECTION_KEYS, { onActiveChange: setCurrentSection, resetKey: block.id });
  // Desktop sidebar keeps the legacy two-tab toggle (Slices/Style) — it has no
  // scroll container, so the continuous model doesn't apply there.
  const [desktopTab, setDesktopTab] = useState<0 | 1>(0);
  // Pending "scroll to this segment when the editor opens" request. Set by a
  // long-press on the wheel canvas; consumed by WheelEditor's
  // scrollToSegmentIndex effect (which clears it via onConsumed).
  const [pendingScrollSegment, setPendingScrollSegment] = useState<number | null>(null);
  // Set for one frame on a close — toggles the SnappingSheet's height transition
  // off so the sheet snaps shut instantly. rAF resets it the next frame.
  const [skipSheetOpenAnim, setSkipSheetOpenAnim] = useState(false);
  // Safety reset whenever the active wheel changes.
  useEffect(() => {
    setSkipSheetOpenAnim(false);
  }, [block.id]);
  // Tap a chip → open the sheet at that section (instant jump on a fresh open so
  // "Slices" lands on the list without painting Templates first), or smooth-
  // scroll to it if already open. Snap target + height are seeded in the same
  // commit as setSheetOpen so the chip-tap is a single React commit.
  const openSheetTo = useCallback((key: Section) => {
    setCurrentSection(key);
    if (sheetOpen) {
      spy.scrollTo(key);
      return;
    }
    setSheetOpen(true);
    const openH = window.innerWidth < 900 ? 380 : 400;
    setSheetSnapTargetH(openH);
    setSheetHeight(openH);
    requestAnimationFrame(() => spy.scrollTo(key, { instant: true }));
  }, [sheetOpen, spy]);
  const closeSheet = useCallback(() => {
    setSkipSheetOpenAnim(true);
    requestAnimationFrame(() => setSkipSheetOpenAnim(false));
    setSheetOpen(false);
    setSheetSnapTargetH(0);
    setSheetHeight(0);
  }, []);
  // Context menu triggered by right-click / long-press on a preview tile.
  // Holds the index of the tile that opened it. null = closed.
  const [ctxMenuIndex, setCtxMenuIndex] = useState<number | null>(null);
  // Wheel clipboard for the Copy / Paste context-menu actions. Seeded from
  // localStorage so a wheel copied in another flow (or before a reload) is
  // available to paste here.
  const [wheelClip, setWheelClip] = useState<WheelClipboard | null>(() => readWheelClipboard());
  // Paste is offered only when there's valid clipboard data AND the Copy
  // happened within PASTE_TTL_MS. Evaluated at render — the context menu opens
  // via a state change, so this is fresh each time the menu appears.
  const canPasteWheel = !!wheelClip && Date.now() - wheelClip.copiedAt < PASTE_TTL_MS;
  // Mobile rename sheet — replaces inline label-editing on touch devices.
  // Holds the preview-tile index being renamed. null = closed.
  const [renameIndex, setRenameIndex] = useState<number | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  // Focus the rename field WITHOUT the browser scrolling the page to reveal
  // it — the sheet (and its keyboard-aware lift) handle visibility. Plain
  // `autoFocus` scroll-into-view yanked the whole screen upward on open.
  useEffect(() => {
    if (renameIndex === null) return;
    const id = requestAnimationFrame(() => renameInputRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(id);
  }, [renameIndex]);
  const openRenameSheet = (idx: number) => {
    const target = flowSteps?.[idx];
    const current = target
      ? (target.wheelConfig?.name ?? target.name)
      : (activeConfig.name || block.name);
    setRenameDraft(current);
    setRenameIndex(idx);
  };
  // Live rename — propagate every keystroke instantly. Active wheel uses
  // editorHistory.patch so typing fills a single undo entry; others go
  // through onBlockUpdated for an app-wide update.
  const liveRenameByIndex = (index: number, name: string) => {
    const step = flowSteps?.[index];
    const targetIsActive = step ? step.id === block.id : index === 0;
    if (targetIsActive) {
      if (name === editorHistory.state.name) return;
      editorHistory.patch({ name });
    } else if (step?.wheelConfig) {
      if (name === step.wheelConfig.name) return;
      onBlockUpdated?.({
        ...step,
        name,
        wheelConfig: { ...step.wheelConfig, name },
      });
    }
  };
  const onRenameDraftChange = (value: string) => {
    setRenameDraft(value);
    if (renameIndex === null) return;
    const trimmed = value.trim();
    if (!trimmed) return;
    liveRenameByIndex(renameIndex, trimmed);
  };
  const closeRenameSheet = () => {
    if (renameIndex === null) return;
    // Seal the undo entry if the active wheel was the one being renamed.
    const step = flowSteps?.[renameIndex];
    const targetIsActive = step ? step.id === block.id : renameIndex === 0;
    if (targetIsActive) editorHistory.commit();
    setRenameIndex(null);
  };
  const [isPlayMode, setIsPlayMode] = useState(false);
  const [sheetHeight, setSheetHeight] = useState(0);
  // Current snap target height (one of [0, midSnap, upperSnap]). Driven
  // by SnappingSheet's `onSnapTargetChange` — the wheel divs read their
  // CSS-transition target values from this. Stays at the most recent
  // snap commit; the CSS transition handles the in-between frames on
  // the browser's compositor timer.
  const [sheetSnapTargetH, setSheetSnapTargetH] = useState(0);
  // True while the user has the finger down on the sheet handle or
  // scroll-drag handoff. During drag we disable the wheel's CSS
  // transition and update its size imperatively per pointermove so it
  // tracks the finger 1:1 instead of easing toward a snap target.
  const [isSheetDragging, setIsSheetDragging] = useState(false);
  // Ref mirror of isSheetDragging — read synchronously by
  // handleSheetHeightChange (a useCallback) without needing it as a
  // dependency. Lets us skip the per-rAF setSheetHeight calls during a
  // snap CSS transition while still tracking the finger during a drag.
  const isSheetDraggingRef = useRef(false);
  // Refs to the wheel divs, used by the drag-time imperative path.
  const wheelOuterRef = useRef<HTMLDivElement | null>(null);
  const wheelInnerRef = useRef<HTMLDivElement | null>(null);
  const wheelAreaRef = useRef<HTMLDivElement | null>(null);
  // Per-rAF ticks during a snap animation are dropped — the wheel /
  // margin / padding / etc. all ride CSS transitions on the browser
  // timer, so re-rendering React 60×/sec during the animation only
  // competes with the compositor and produces visible lag. We still
  // update on:
  //   • snap commit (`committed=true`) — sets the React truth for
  //     spacerProgress-driven props (header opacity etc.) at the start
  //     of an open/close, so they're correct for the CSS transition.
  //   • drag (`isSheetDraggingRef.current`) — finger tracks 1:1.
  const handleSheetHeightChange = useCallback((h: number, committed?: boolean) => {
    if (!committed && !isSheetDraggingRef.current) return;
    setSheetHeight(h);
  }, []);
  // [SHEET-DBG] refs for the chip bar + sheet so the debug effect can
  // read live bounding rects on every height change. Defined here so
  // they're stable across renders; the effect itself lives after
  // screenHeight is computed (further down).
  const chipBarDbgRef = useRef<HTMLDivElement | null>(null);
  const sheetDbgRef = useRef<HTMLDivElement | null>(null);
  // True while a segment-reorder gesture is active inside the WheelEditor.
  // Stored in a ref so the SnappingSheet can read it synchronously from
  // its pointer handlers — using state would lag by one render commit
  // and let the sheet drag a few px under the finger before the lock
  // engaged.
  const editorReorderingRef = useRef(false);
  const handleEditorReorderingChange = useCallback((active: boolean) => {
    editorReorderingRef.current = active;
  }, []);
  // Sheet drag is suppressed while EITHER a segment reorder OR a
  // SwipeableActionCell horizontal swipe is in progress — both
  // gestures compete for the same vertical pointer movement and we
  // don't want them firing concurrently.
  const isSheetDragLocked = useCallback(
    () => editorReorderingRef.current || isAnyCellSwipeDragActive(),
    [],
  );
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  // activeConfig: previewConfig wins only if it belongs to the CURRENT block.
  // Comparing by wheelConfig.id protects against stale previewConfig carrying
  // over when switching wheels in a flow (that's what caused the flash).
  const baseConfig = block.wheelConfig!;
  const activeConfig =
    previewConfig && previewConfig.id === baseConfig.id ? previewConfig : baseConfig;
  const [viewport, setViewport] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const screenWidth = viewport.w;
  const screenHeight = viewport.h;
  const isMobile = screenWidth < 900;
  // Orthogonal to layout-mobile: "is this a touch-primary device" — used
  // for UX decisions (mobile-style rename sheet vs. inline label edit). A
  // PC with a small window isn't touch-primary, so it keeps inline editing.
  const isTouchPrimary = typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(pointer: coarse)').matches;
  const idealWheelSize = 700;
  const availableWidth = isMobile ? (screenWidth - 16) : (screenWidth - 400 - 32);
  const effectiveWheelSize = Math.min(availableWidth, idealWheelSize);

  const onWheelFinished = useCallback((index: number) => {
    const updated = { ...block, lastUsedAt: new Date().toISOString() };
    onBlockUpdated?.(updated);
  }, [block, onBlockUpdated]);

  // Holds the latest un-persisted config so flushAutoSave can write it immediately.
  const pendingConfigRef = useRef<WheelConfig | null>(null);

  const handleWheelPreview = useCallback((config: WheelConfig) => {
    setPreviewConfig(config);
    pendingConfigRef.current = config;
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = setTimeout(() => {
      // onBlockUpdated pushes the config back through the block prop, which
      // makes it the new baseConfig. previewConfig can stay set for now — it
      // matches baseConfig so the derived activeConfig is identical.
      const updated = { ...block, name: config.name, wheelConfig: config };
      onBlockUpdated?.(updated);
      pendingConfigRef.current = null;
    }, 500);
  }, [block, onBlockUpdated]);

  const flushAutoSave = useCallback(() => {
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = undefined;
    }
    const pending = pendingConfigRef.current;
    if (!pending) return;
    onBlockUpdated?.({ ...block, name: pending.name, wheelConfig: pending });
    pendingConfigRef.current = null;
  }, [block, onBlockUpdated]);

  // Flush on unmount (handles back nav, route changes, tab close via React cleanup).
  const flushRef = useRef(flushAutoSave);
  flushRef.current = flushAutoSave;
  useEffect(() => () => flushRef.current(), []);

  const configId = block.wheelConfig?.id ?? Date.now().toString();
  const handleHistoryChange = useCallback((s: EditorState) => {
    if (!s.name.trim()) return;
    handleWheelPreview(stateToConfig(s, configId));
  }, [handleWheelPreview, configId]);
  const editorHistory = useHistory(buildInitialState(block.wheelConfig, block.id), handleHistoryChange, block.id);

  // Remember the vibe of the wheel currently open — whenever its slice colours
  // genuinely match one — so a freshly-added wheel inherits it (the Home add
  // button reads this "selected vibe"). A custom palette (no match) leaves the
  // remembered vibe untouched. Covers both opening a wheel and tapping a vibe
  // (which recolours the slices → this fires).
  const vibeColorsKey = editorHistory.state.segments.map(s => s.color).join(',');
  useEffect(() => {
    const m = matchedVibe(vibeColorsKey ? vibeColorsKey.split(',') : []);
    if (m) rememberSelectedVibe(m.key);
  }, [vibeColorsKey]);

  // ── Flow history ───────────────────────────────────────────────────────
  // Mirrors the pattern used by the wheel-editor's useHistory: a single
  // snapshot struct tracked across set/undo/redo, onChange applies the new
  // state externally and persists the Firestore delta. Each ctx-menu action
  // (delete / duplicate / insert) and reorder-commit pushes a snapshot via
  // flowHistory.set, so undo/redo in the red footer reverts them naturally.
  type FlowHistState = { experience: CloudBlock | undefined; steps: CloudBlock[] };
  const initialFlowState: FlowHistState = {
    experience: flowExperience,
    steps: flowSteps ?? [],
  };
  // Tracks the last state that was applied + persisted externally. Diff
  // against new state inside onChange tells us what to save/delete.
  const appliedFlowRef = useRef<FlowHistState>(initialFlowState);

  const computeFlowDelta = (prev: FlowHistState, next: FlowHistState) => {
    const writes: CloudBlock[] = [];
    const deletes: string[] = [];
    // Experience doc: save if present (covers created + reordered), delete if
    // the flow was dissolved.
    if (next.experience) writes.push(next.experience);
    else if (prev.experience) deletes.push(prev.experience.id);
    // Step blocks: save any whose id is new to this snapshot (insert /
    // duplicate / restored-on-undo); delete any missing (delete / undone-insert).
    const prevIds = new Set(prev.steps.map(s => s.id));
    const nextIds = new Set(next.steps.map(s => s.id));
    for (const s of next.steps) if (!prevIds.has(s.id)) writes.push(s);
    for (const s of prev.steps) if (!nextIds.has(s.id)) deletes.push(s.id);
    return { writes, deletes };
  };

  // Set to true by finishRelease just before commitFlowSet, so the redundant
  // onFlowChange call from flowHistory's [hist] useEffect is skipped — we
  // already called onFlowChange directly with the same args. Without this
  // dedupe, the late useEffect-driven call would fire AFTER our rAF-clear of
  // isCommitting, causing the BlockScreen → RouletteScreen prop chain to
  // re-render with `flowSteps` again, which (combined with the App.setBlocks
  // cascade from onBlockUpdated below) caused React to remount the active
  // PreviewTile and re-fire its tile-pop-in animation — i.e. the bounce.
  const skipNextHistoryOnChangeRef = useRef(false);

  const handleFlowHistoryChange = useCallback((s: FlowHistState) => {
    const prev = appliedFlowRef.current;
    appliedFlowRef.current = s;
    if (skipNextHistoryOnChangeRef.current) {
      skipNextHistoryOnChangeRef.current = false;
    } else {
      onFlowChange?.(s.experience, s.steps);
    }
    if (!user) return;
    const delta = computeFlowDelta(prev, s);
    if (delta.writes.length === 0 && delta.deletes.length === 0) return;
    // Route writes through onBlockUpdated so App.blocks (and thus Profile
    // list / feed) update immediately — not just Firestore. onBlockUpdated
    // internally does the saveDraft.
    for (const b of delta.writes) onBlockUpdated?.(b);
    // Deletes go through onBlockDelete which updates App.blocks optimistically
    // AND deletes from Firestore in the background — so when the last step
    // of an Experience is removed, both the wheel id and the parent
    // Experience id disappear from the profile this frame.
    for (const id of delta.deletes) {
      if (onBlockDelete) {
        onBlockDelete(id);
      } else {
        deleteDraft(user.uid, id).catch(err => dbg('RouletteScreen', 'flow-history:delete-fail', { err: String(err) }));
      }
    }
  }, [user, onFlowChange, onBlockUpdated, onBlockDelete]);

  // No resetKey — RouletteScreen is unmounted by FullScreenSheet when the
  // overlay closes, so flow history is naturally scoped to a single edit
  // session. We deliberately avoid resetting on flowExperience?.id changes,
  // since a standalone→flow transition (via insert-before/after or +) would
  // otherwise wipe the undo stack right after the op that created the flow.
  const flowHistory = useHistory<FlowHistState>(
    initialFlowState,
    handleFlowHistoryChange,
  );

  // ── Shared op log (for unified undo/redo across both histories) ────────
  type OpKind = 'editor' | 'flow';
  const opLogRef = useRef<OpKind[]>([]);
  const opRedoLogRef = useRef<OpKind[]>([]);
  const editorDirtyRef = useRef(false);
  const flowDirtyRef = useRef(false);
  // Reactive enablement for the buttons — refs alone don't trigger re-render.
  const [opCanUndo, setOpCanUndo] = useState(false);
  const [opCanRedo, setOpCanRedo] = useState(false);
  const syncOpFlags = () => {
    setOpCanUndo(editorDirtyRef.current || flowDirtyRef.current || opLogRef.current.length > 0);
    setOpCanRedo(opRedoLogRef.current.length > 0);
  };
  const pushOp = (kind: OpKind) => {
    opLogRef.current.push(kind);
    opRedoLogRef.current = [];
    syncOpFlags();
  };

  // Wrapped editor history used by WheelEditor. set / first patch / commit
  // record an 'editor' op so unified undo knows what to pop.
  const wrappedEditorHistory: typeof editorHistory = {
    ...editorHistory,
    set: (next) => { editorHistory.set(next); pushOp('editor'); },
    patch: (partial) => { editorHistory.patch(partial); editorDirtyRef.current = true; syncOpFlags(); },
    commit: () => {
      editorHistory.commit();
      if (editorDirtyRef.current) {
        editorDirtyRef.current = false;
        pushOp('editor');
      }
    },
    undo: () => unifiedUndo(),
    redo: () => unifiedRedo(),
  };

  const unifiedUndo = () => {
    // Pending (uncommitted) edits are their own undo step — handled by the
    // relevant history's undo (strips the dirty entry) without touching the
    // op log.
    if (editorDirtyRef.current) {
      editorHistory.undo();
      editorDirtyRef.current = false;
      syncOpFlags();
      return;
    }
    if (flowDirtyRef.current) {
      flowHistory.undo();
      flowDirtyRef.current = false;
      syncOpFlags();
      return;
    }
    const op = opLogRef.current.pop();
    if (!op) return;
    opRedoLogRef.current.push(op);
    if (op === 'editor') editorHistory.undo();
    else flowHistory.undo();
    syncOpFlags();
  };

  const unifiedRedo = () => {
    const op = opRedoLogRef.current.pop();
    if (!op) return;
    opLogRef.current.push(op);
    if (op === 'editor') editorHistory.redo();
    else flowHistory.redo();
    syncOpFlags();
  };

  // Helper for flow mutations: applies the snapshot via history.set (onChange
  // takes care of both local state and Firestore delta) and records the op.
  const commitFlowSet = (next: FlowHistState) => {
    flowHistory.set(next);
    pushOp('flow');
  };

  // When the block prop changes (flow switch), clear any stale preview state.
  // activeConfig immediately falls back to the new block.wheelConfig (by id
  // mismatch), but this cleanup keeps state tidy and breaks reference chains.
  // Block-change cleanup runs as a LAYOUT effect, not a plain useEffect:
  // it fires after the post-block-change commit but BEFORE the browser
  // paints. Since `wheelConfig.id` is stable across wheels in this data,
  // a stale `previewConfig` left over from the previous wheel still
  // satisfies activeConfig's id-match check and would flash the OLD
  // wheel's items in active-tile thumbnails for one paint. Clearing here
  // forces a follow-up render with previewConfig=null that React commits
  // before the browser paints, so the user never sees the stale frame.
  // This catches all block.id change paths (tile tap, URL navigation,
  // route sync) without requiring each click-handler to call it manually.
  useLayoutEffect(() => {
    dbg('RouletteScreen', 'block-change', {
      block: sid(block.id),
      items: block.wheelConfig?.items.length ?? 0,
      flowSteps: sids(flowSteps),
    });
    setPreviewConfig(null);
    pendingConfigRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [block.id]);

  // Log when flowSteps changes content
  const prevFlowIdsRef = useRef<string>('');
  useEffect(() => {
    const ids = (flowSteps ?? []).map(s => s.id).join(',');
    if (ids !== prevFlowIdsRef.current) {
      dbg('RouletteScreen', 'flowSteps-change', {
        from: prevFlowIdsRef.current || 'ø',
        to: sids(flowSteps),
        count: flowSteps?.length ?? 0,
      });
      prevFlowIdsRef.current = ids;
    }
  }, [flowSteps]);

  // Preview row scroll-to-start on mount. RouletteScreen remounts each time
  // the overlay is re-opened (FullScreenSheet unmounts its children on close),
  // so this fires once per "open edit" action.
  const previewRowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    previewRowRef.current?.scrollTo({ left: 0, behavior: 'auto' });
  }, []);

  // ── Row-level scroll enhancements (mouse) ──────────────────────────────
  // The preview row is a native horizontal scroller for touch + trackpad, but
  // a regular desktop mouse can't pan it by drag. These handlers add:
  //  - click-drag to scroll the row (with momentum on release)
  //  - vertical wheel redirected to horizontal scroll
  // Click suppression flag prevents an accidental tile navigate after a drag.
  const clickSuppressUntilRef = useRef(0);
  const shouldSuppressTileClick = useCallback(
    () => Date.now() < clickSuppressUntilRef.current,
    [],
  );
  // Handle to the running momentum animation so a new drag / wheel event
  // can cancel it immediately.
  const inertiaRafRef = useRef<number | null>(null);
  const cancelInertia = useCallback(() => {
    if (inertiaRafRef.current !== null) {
      cancelAnimationFrame(inertiaRafRef.current);
      inertiaRafRef.current = null;
    }
  }, []);
  // Cleanup for an in-progress mouse drag-to-scroll. Called when a long-press
  // activates so the row stops panning mid-drag.
  const rowDragCleanupRef = useRef<(() => void) | null>(null);
  // Kick off a momentum animation after a drag ends. Velocity is in
  // scrollLeft-px per ms (sign matches scrollLeft direction). Decay is tuned
  // for a ~500ms glide with typical flick velocities.
  const startInertia = useCallback((velocity: number) => {
    const row = previewRowRef.current;
    if (!row) return;
    cancelInertia();
    const DECAY_PER_MS = 0.004; // exponential decay rate
    const MIN_V = 0.02;         // px/ms — stop threshold
    let v = velocity;
    let lastTime = performance.now();
    const tick = (now: number) => {
      const dt = now - lastTime;
      lastTime = now;
      row.scrollLeft += v * dt;
      v *= Math.exp(-DECAY_PER_MS * dt);
      if (Math.abs(v) < MIN_V) {
        inertiaRafRef.current = null;
        return;
      }
      inertiaRafRef.current = requestAnimationFrame(tick);
    };
    inertiaRafRef.current = requestAnimationFrame(tick);
  }, [cancelInertia]);

  const handleRowWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    const row = previewRowRef.current;
    if (!row) return;
    cancelInertia();
    // Prefer vertical-wheel → horizontal-scroll (laptop touchpads already
    // emit deltaX natively; this just helps standard mouse wheels).
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      row.scrollLeft += e.deltaY;
      e.preventDefault();
    }
  }, [cancelInertia]);

  const handleRowMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const row = previewRowRef.current;
    if (!row) return;
    cancelInertia();
    // If a previous drag's window listeners somehow linger, kill them first.
    rowDragCleanupRef.current?.();
    const startX = e.clientX;
    const startScrollLeft = row.scrollLeft;
    let didDrag = false;
    // Track recent pointer samples so we can compute release velocity.
    let lastSampleX = e.clientX;
    let lastSampleTime = performance.now();
    let velocity = 0; // px/ms in scrollLeft direction (opposite of mouse X)

    const onMove = (me: MouseEvent) => {
      const dx = me.clientX - startX;
      if (!didDrag && Math.abs(dx) > 4) didDrag = true;
      if (!didDrag) return;
      const now = performance.now();
      const dt = now - lastSampleTime;
      if (dt > 0) {
        const frameVelocity = -(me.clientX - lastSampleX) / dt;
        velocity = velocity * 0.3 + frameVelocity * 0.7;
      }
      lastSampleX = me.clientX;
      lastSampleTime = now;
      row.scrollLeft = startScrollLeft - dx;
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
        // If the user was still moving at release, glide.
        const sinceLastSample = performance.now() - lastSampleTime;
        if (sinceLastSample < 80 && Math.abs(velocity) > 0.1) {
          startInertia(velocity);
        }
      }
    };
    rowDragCleanupRef.current = cleanup;
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [cancelInertia, startInertia]);

  // ── Reorder (long-press + drag sideways on a preview tile) ─────────────
  // Ported from the WheelEditor segment-reorder pattern:
  //  - Parent owns per-tile refs (tileElsRef).
  //  - On long-press threshold (from PreviewTile's onGrabStart), window-level
  //    pointermove / pointerup listeners are attached; these drive the
  //    hit-test + live swap so pointer capture isn't needed (pre-threshold
  //    scroll on the row keeps working).
  //  - Midpoint hit-testing via getBoundingClientRect for smoother swaps.
  const tileElsRef = useRef<(HTMLDivElement | null)[]>([]);
  const [grabbedIndex, setGrabbedIndex] = useState<number | null>(null);
  // Optimistic "tapped" tile id — set the moment the user taps a preview
  // so the active highlight moves immediately, without waiting for the
  // navigate() → BlockScreen useEffect → setBlock → re-render pipeline
  // (which costs 1–2 frames the user perceives as a stutter). Cleared on
  // the next render where block.id has caught up.
  const [optimisticActiveId, setOptimisticActiveId] = useState<string | null>(null);
  useEffect(() => {
    if (optimisticActiveId === block.id) setOptimisticActiveId(null);
  }, [block.id, optimisticActiveId]);
  const effectiveActiveId = optimisticActiveId ?? block.id;
  // Live pointer-follow offset for the grabbed tile. Plain (pointerX - startX)
  // — no slot-swap compensation needed because the array isn't reordered
  // during the drag; the tile stays in its original DOM slot the whole time.
  const [dragOffsetX, setDragOffsetX] = useState(0);
  // Where the grabbed tile WILL drop on release. While dragging, the
  // neighbors between source and dropTarget shift left/right by one slot to
  // open an empty spot for the drop.
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);
  // Phase-1 settling: after release, the grabbed tile animates from the
  // pointer to the drop slot via translateX (with the same easing as a
  // regular drag-back). While true, transition timing for the grabbed
  // tile flips from 0s (instant pointer-follow) to 0.22s (settle glide).
  const [isSettling, setIsSettling] = useState(false);
  // Phase-2 commit window: true for exactly one paint frame while the
  // array reorder lands. During that frame every tile's `transform` value
  // changes (from finalOffset / slotOffset back to 0) at the same moment
  // its natural DOM position shifts. We must NOT animate that transform
  // change — the natural position shift already moves the tile to its
  // resting spot, so animating the transform on top would re-translate
  // past the rest spot and bounce back. Reset to false on next rAF.
  const [isCommitting, setIsCommitting] = useState(false);
  // Pending phase-2 commit timer. Cleared if a new grab starts before the
  // settle finishes — prevents the in-flight commit from clobbering fresh
  // drag state with the previous drop's reorder.
  const settleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Tracks every wheel id that has already been rendered as a preview tile
  // in this RouletteScreen instance. We skip the tile pop-in animation for
  // any id we've seen before so the first wheel doesn't re-pop when the JSX
  // path changes from standalone-tile to flow-tile on the first +-add.
  const mountedTileIdsRef = useRef<Set<string>>(new Set());
  // Snapshot the seen-set at render time so we can use it within this render
  // to decide skipPopIn (vs the post-render mutation below).
  const seenTileIds = mountedTileIdsRef.current;
  // After every commit, mark the tile ids that just rendered as "seen" — the
  // sentinel '__plus__' covers the always-present + tile so it doesn't
  // re-pop when the standalone → flow JSX path swap happens.
  useEffect(() => {
    if (flowSteps && flowSteps.length > 0) {
      flowSteps.forEach(s => mountedTileIdsRef.current.add(s.id));
    } else if (block) {
      mountedTileIdsRef.current.add(block.id);
    }
    mountedTileIdsRef.current.add('__plus__');
  });

  // (FLIP removed — release uses a two-phase approach instead. See onUp:
  // phase 1 animates the grabbed tile's translateX to its drop slot via
  // the existing React-controlled transition, then phase 2 commits the
  // array reorder atomically — at which point every tile's new natural
  // position already matches its phase-1 visible position, so no visual
  // jump occurs and no FLIP is needed.)

  // ── Reorder debug logging ──────────────────────────────────────────
  // Logs the row's flowSteps id ordering whenever it changes. Combined
  // with the [Tile#id] MOUNT/UNMOUNT logs in PreviewTile, you can see
  // whether React preserved instances across a reorder or recreated them.
  const prevFlowOrderRef = useRef<string>('');
  useEffect(() => {
    const order = (flowSteps ?? []).map(s => s.id).join(' | ');
    if (order !== prevFlowOrderRef.current) {
      // eslint-disable-next-line no-console
      console.log(`[Row] order changed\n  prev=[${prevFlowOrderRef.current}]\n  next=[${order}]`);
      prevFlowOrderRef.current = order;
    }
  }, [flowSteps]);

  // Slot-shift offset for a non-grabbed neighbor at index `i` while the user
  // is dragging the tile at `sourceIndex` toward `dropTargetIndex`. Tiles
  // between source and target shift one slot toward source, opening an
  // empty slot at target where the grabbed tile will land on release.
  const SLOT_WIDTH = 98; // tile (88) + gap (10)
  const computeSlotOffset = (i: number): number => {
    if (grabbedIndex === null || dropTargetIndex === null) return 0;
    if (i === grabbedIndex) return 0; // grabbed tile owns its own transform
    if (dropTargetIndex > grabbedIndex) {
      // Dragging right — tiles in (source, target] shift left.
      if (i > grabbedIndex && i <= dropTargetIndex) return -SLOT_WIDTH;
    } else if (dropTargetIndex < grabbedIndex) {
      // Dragging left — tiles in [target, source) shift right.
      if (i >= dropTargetIndex && i < grabbedIndex) return SLOT_WIDTH;
    }
    return 0;
  };
  // Always-current refs so the window-level handlers created at grab-start
  // can see the latest flow state after subsequent swaps.
  const flowExperienceRef = useRef(flowExperience);
  const flowStepsRef = useRef(flowSteps);
  flowExperienceRef.current = flowExperience;
  flowStepsRef.current = flowSteps;

  // A flow shows its own title only when it has MORE than one wheel. With a
  // single wheel, the wheel's title doubles as the flow title (the top bar edits
  // the wheel name, below).
  const titleIsFlow = !!(flowExperience && flowSteps && flowSteps.length > 1);
  // One-wheel flow: mirror the wheel name onto the experience doc (debounced) so
  // the profile / feed match. One-directional — the top bar edits the wheel name
  // for a one-step flow, so this never fights a flow-name edit. `patch` keeps
  // flow-history's working state correct for any later flow op; `onBlockUpdated`
  // persists the experience + propagates to other views.
  useEffect(() => {
    if (!flowExperience || !flowSteps || flowSteps.length !== 1) return;
    const wheelName = editorHistory.state.name;
    if (flowExperience.name === wheelName) return;
    const exp = flowExperience;
    const t = setTimeout(() => {
      flowHistory.patch({ experience: { ...exp, name: wheelName } });
      onBlockUpdated?.({ ...exp, name: wheelName });
    }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorHistory.state.name, flowExperience, flowSteps]);

  // (Removed: an old reorder-pop-animation effect that fired el.animate()
  // on tiles whose array index changed. It started keyframes at scale(0.6),
  // which was the source of the post-commit bounce. The new two-phase
  // release in handleGrabStart already animates the drop smoothly, so this
  // legacy effect is no longer needed.)

  const handleGrabStart = useCallback((sourceIndex: number, startX: number, startY: number) => {
    // Lock scroll: stop momentum glide + tear down any in-progress mouse
    // drag-to-scroll so the row freezes the moment the grab activates.
    cancelInertia();
    rowDragCleanupRef.current?.();
    // Cancel any pending phase-2 settle from the previous drop — its
    // finishRelease would otherwise fire mid-grab and stomp this state.
    if (settleTimeoutRef.current) {
      clearTimeout(settleTimeoutRef.current);
      settleTimeoutRef.current = null;
    }
    const startFlowSteps = flowStepsRef.current;
    const startFlowExp = flowExperienceRef.current;
    if (!startFlowSteps || !startFlowExp) {
      // Standalone (no flow) — long-press still selects; no reorder possible.
      // Release behavior falls back to context menu via onContextOpen.
      return;
    }

    // Single-step flow — reorder is meaningless. Skip the grab visual
    // entirely (which would otherwise scale-up the tile and rely on a
    // pointerup to clear it) and just open the context menu.
    if (startFlowSteps.length <= 1) {
      setCtxMenuIndex(sourceIndex);
      return;
    }

    let currentTarget = sourceIndex;
    let dragged = false; // true once the pointer crosses the activation threshold
    setGrabbedIndex(sourceIndex);
    setDragOffsetX(0);
    setDropTargetIndex(sourceIndex);
    dbg('RouletteScreen', 'reorder:start', { index: sourceIndex });

    const onMove = (me: PointerEvent) => {
      const dx = me.clientX - startX;
      const dy = me.clientY - startY;
      // Plain follow — the grabbed tile sits in its original DOM slot and
      // is offset by (pointerX - startX). No slot-swap compensation needed.
      setDragOffsetX(dx);

      // Require a meaningful movement from the grab-start position before
      // we shift neighbors. Avoids twitchy slot indicators on sub-pixel
      // jitter at the start of a press. The first time we cross the
      // threshold we mark this gesture as a drag — even if the user later
      // releases over the source slot, we treat it as a "no-op reorder"
      // rather than a long-press, so the context menu stays closed.
      if (Math.hypot(dx, dy) < 10) return;
      dragged = true;
      const steps = flowStepsRef.current;
      if (!steps) return;

      // Compute drop target from the pointer's offset relative to the
      // source tile's natural center, measured in slot widths. This lets
      // target === source when the pointer is over the source slot itself
      // (so dropping back in place is reachable + the context-menu
      // shortcut fires correctly), and avoids the asymmetry of skipping
      // the source from a midpoint-iteration hit-test.
      const sourceEl = tileElsRef.current[sourceIndex];
      if (!sourceEl) return;
      const sourceRect = sourceEl.getBoundingClientRect();
      const sourceCenter = sourceRect.left + sourceRect.width / 2;
      const offsetSlots = Math.round((me.clientX - sourceCenter) / SLOT_WIDTH);
      const target = Math.max(0, Math.min(steps.length - 1, sourceIndex + offsetSlots));
      if (target === currentTarget) return;
      currentTarget = target;
      // Re-render: neighbors between source and target shift sideways by
      // one slot to open an empty drop spot at `target`.
      setDropTargetIndex(target);
    };

    const cleanup = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };

    // Two-phase release. Phase 1 animates the grabbed tile to its drop slot
    // via translateX (same transition the rest of the row uses), without
    // touching the array. Phase 2, after the animation finishes, commits
    // the array reorder atomically — at that moment every tile's new
    // natural position already equals where it's currently rendered, so
    // there is no visual jump and no FLIP is needed.
    const finishRelease = (commit: boolean) => {
      const steps = flowStepsRef.current;
      const exp = flowExperienceRef.current;
      if (commit && steps && exp?.experienceConfig) {
        const nextSteps = [...steps];
        const [movedStep] = nextSteps.splice(sourceIndex, 1);
        nextSteps.splice(currentTarget, 0, movedStep);
        const nextEntries = [...exp.experienceConfig.steps];
        const [movedEntry] = nextEntries.splice(sourceIndex, 1);
        nextEntries.splice(currentTarget, 0, movedEntry);
        const nextExp: CloudBlock = {
          ...exp,
          experienceConfig: { ...exp.experienceConfig, steps: nextEntries },
        };
        onFlowChange?.(nextExp, nextSteps);
        // Mark the upcoming flowHistory.set's onChange (fired late via its
        // [hist] useEffect) as redundant — we just called onFlowChange and
        // a second call with the same content would re-render BlockScreen
        // and cascade into a PreviewTile remount + pop-in re-fire.
        skipNextHistoryOnChangeRef.current = true;
        commitFlowSet({ experience: nextExp, steps: nextSteps });
      }
      setGrabbedIndex(null);
      setDragOffsetX(0);
      setDropTargetIndex(null);
      setIsSettling(false);
    };

    const onUp = () => {
      dbg('RouletteScreen', 'reorder:onUp', { sourceIndex, currentTarget, dragged });
      cleanup();
      if (currentTarget !== sourceIndex) {
        // Phase 1: glide the grabbed tile from current pointer offset to
        // the drop slot's offset. The dropTargetIndex stays put, so
        // neighbors hold their drag positions throughout. The 0.22s
        // matches every other transition in the row.
        const finalOffset = (currentTarget - sourceIndex) * SLOT_WIDTH;
        // eslint-disable-next-line no-console
        console.log(`[Reorder] phase1:start source=${sourceIndex} target=${currentTarget} finalOffset=${finalOffset}`);
        setIsSettling(true);
        setDragOffsetX(finalOffset);
        settleTimeoutRef.current = setTimeout(() => {
          settleTimeoutRef.current = null;
          // eslint-disable-next-line no-console
          console.log(`[Reorder] phase2:commit source=${sourceIndex} target=${currentTarget}`);
          // Suppress transform transitions for the commit frame, then
          // re-enable on next rAF so subsequent ops animate normally.
          setIsCommitting(true);
          finishRelease(true);
          requestAnimationFrame(() => {
            // eslint-disable-next-line no-console
            console.log(`[Reorder] phase2:rAF-cleared`);
            setIsCommitting(false);
          });
        }, 220);
      } else {
        if (!dragged) setCtxMenuIndex(sourceIndex);
        // eslint-disable-next-line no-console
        console.log(`[Reorder] no-commit source=${sourceIndex} dragged=${dragged}`);
        finishRelease(false);
      }
    };

    const onCancel = () => {
      dbg('RouletteScreen', 'reorder:onCancel', { sourceIndex, currentTarget });
      cleanup();
      if (currentTarget !== sourceIndex) {
        const finalOffset = (currentTarget - sourceIndex) * SLOT_WIDTH;
        setIsSettling(true);
        setDragOffsetX(finalOffset);
        settleTimeoutRef.current = setTimeout(() => {
          settleTimeoutRef.current = null;
          setIsCommitting(true);
          finishRelease(true);
          requestAnimationFrame(() => setIsCommitting(false));
        }, 220);
      } else {
        finishRelease(false);
      }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  }, [user, onFlowChange, cancelInertia]);

  // ── Context-menu actions (delete / duplicate / insert) ─────────────────
  // `index` is the preview-tile position. For standalone (no flow), index is
  // always 0 and refers to the current block. For flows, it refers to
  // flowSteps[index]. All actions update local state optimistically and
  // persist in the background, rolling back on failure.
  type CtxAction = 'delete' | 'duplicate' | 'insertBefore' | 'insertAfter' | 'copy' | 'paste';
  const runCtxAction = useCallback(async (action: CtxAction, index: number) => {
    if (!user) return;
    flushAutoSave();
    const currentBlock = { ...block, wheelConfig: activeConfig } as CloudBlock;
    const inFlow = !!(flowExperience && flowSteps && flowSteps.length > 0);

    // Copy is a pure read — stash the target tile's config (deep-cloned via
    // localStorage JSON) on the wheel clipboard. No flow mutation.
    if (action === 'copy') {
      const cfg = inFlow ? flowSteps![index]?.wheelConfig : activeConfig;
      if (cfg) {
        writeWheelClipboard(cfg);
        setWheelClip(readWheelClipboard());
      }
      return;
    }

    try {
      if (inFlow) {
        const exp = flowExperience!;
        const steps = flowSteps!;
        if (action === 'delete') {
          const change = buildRemoveWheelChange({ experience: exp, steps, index });
          const deletedActive = steps[index].id === block.id;
          commitFlowSet({ experience: change.experience ?? undefined, steps: change.nextSteps });
          if (deletedActive) {
            if (change.nextSteps.length > 0) {
              const nextIdx = Math.min(index, change.nextSteps.length - 1);
              navigate(`/block/${change.nextSteps[nextIdx].id}`, {
                replace: true,
                state: {
                  block: change.nextSteps[nextIdx], editMode: true,
                  flowExperience: change.experience ?? undefined,
                  flowSteps: change.nextSteps,
                },
              });
            } else {
              navigate('/');
            }
          }
          return;
        }
        if (action === 'duplicate') {
          const change = buildDuplicateWheelChange({ experience: exp, steps, index });
          commitFlowSet({ experience: change.experience ?? undefined, steps: change.nextSteps });
          return;
        }
        if (action === 'paste') {
          if (!wheelClip) return;
          // Insert the clipboard wheel right after the tapped tile.
          const change = buildInsertWheelChange({
            currentBlock, experience: exp, steps, index: index + 1, wheelConfig: wheelClip.config,
          });
          commitFlowSet({ experience: change.experience ?? undefined, steps: change.nextSteps });
          return;
        }
        if (action === 'insertBefore' || action === 'insertAfter') {
          const targetIndex = action === 'insertBefore' ? index : index + 1;
          const change = buildInsertWheelChange({
            currentBlock, experience: exp, steps, index: targetIndex,
          });
          commitFlowSet({ experience: change.experience ?? undefined, steps: change.nextSteps });
          return;
        }
      } else {
        // Standalone wheel — no flow context.
        if (action === 'delete') {
          // Optimistic: navigate home immediately, persist + drop from
          // App.blocks in the background.
          navigate('/');
          if (onBlockDelete) {
            onBlockDelete(block.id);
          } else {
            deleteDraft(user.uid, block.id).catch(err => {
              dbg('RouletteScreen', 'ctx:delete:standalone-fail', { err: String(err) });
            });
          }
          return;
        }
        if (action === 'duplicate') {
          const newId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
          const now = new Date().toISOString();
          const clone: CloudBlock = {
            ...currentBlock,
            id: newId,
            createdAt: now,
            lastUsedAt: now,
            publishedWheelId: null,
            wheelConfig: currentBlock.wheelConfig
              ? { ...currentBlock.wheelConfig, id: newId }
              : currentBlock.wheelConfig,
          };
          await saveDraft(user.uid, clone);
          return;
        }
        if (action === 'paste') {
          if (!wheelClip) return;
          // Wrap the standalone wheel + the pasted clipboard wheel into a
          // fresh flow, the pasted one landing second (after the current).
          const change = buildInsertWheelChange({ currentBlock, index: 1, wheelConfig: wheelClip.config });
          commitFlowSet({ experience: change.experience ?? undefined, steps: change.nextSteps });
          const stampedCurrent = change.writes.find(w => w.id === block.id);
          if (stampedCurrent) onBlockUpdated?.(stampedCurrent);
          return;
        }
        if (action === 'insertBefore' || action === 'insertAfter') {
          const targetIndex = action === 'insertBefore' ? 0 : 1;
          const change = buildInsertWheelChange({ currentBlock, index: targetIndex });
          commitFlowSet({ experience: change.experience ?? undefined, steps: change.nextSteps });
          // Ensure App.blocks gets the newly-stamped current block (its
          // parentExperienceId just changed), so the profile list updates.
          const stampedCurrent = change.writes.find(w => w.id === block.id);
          if (stampedCurrent) onBlockUpdated?.(stampedCurrent);
          return;
        }
      }
    } catch (e) {
      dbg('RouletteScreen', 'ctx:build-fail', { action, err: e instanceof Error ? e.message : String(e) });
      alert(e instanceof Error ? e.message : 'Action failed.');
    }
  }, [user, block, activeConfig, flowExperience, flowSteps, navigate, onFlowChange, onBlockUpdated, onBlockDelete, flushAutoSave, wheelClip]);

  // Dynamic wheel sizing — the wheel + sheet area is a flex column:
  //   child1 (flex:1): app bar + wheel + red container (red grows with sheet)
  //   child2 (flex-shrink:0, 48px): chip bar
  // Red container absorbs sheet height so the wheel shrinks in lockstep.
  const RED_BASE = 136;   // red container minimum (preview row + padding)
  const CHIP_H = 56;      // pinned chip bar
  const SPIN_H = 66;      // spin button (54) + margin (12)
  const APP_BAR_PAD = 54; // matches the always-visible app bar exactly
  const bottomControlsHeight = 96;
  const grabbingHeight = 30;
  const midSnap = isMobile ? 380 : 400;
  const spacerProgress = isMobile ? Math.min(sheetHeight / midSnap, 1) : 0;
  // Red box's actual DOM height — fixed at RED_BASE (not flexible).
  const redBoxHeight = isPlayMode ? 0 : RED_BASE;
  // Wheel sizing algebra: wheel + 0.03·wheel + 0.015·wheel·headerProg
  // + constHeader + constSpacers = avail — solved inside `wheelStateAt`
  // below for each snap target. The live per-frame chain that used to
  // live here has been replaced with a snap-target precomputation +
  // CSS transition matching the sheet's own height transition.
  const WHEEL_PADDING_RATIO = 0.03;
  const HEADER_TEXT_PAD_RATIO = 0.015;
  // Static scale: stays constant across sheet drags so the canvas never
  // needs to re-paint for size changes.
  const staticScale = effectiveWheelSize / idealWheelSize;
  // Endpoint of the opacity fade-out — wheel fully transparent at this
  // sheet height. Used inside `wheelStateAt` below.
  const upperSnap = screenHeight - 80;

  // ── Snap-target-driven wheel sizing (CSS transition path) ───────────
  // The wheel is animated by the BROWSER, not React: it sits on a CSS
  // transition whose timing curve matches the sheet's, so the two move
  // in lockstep regardless of main-thread pressure. The wheel divs read
  // their width/height/scale/margin from precomputed snap targets
  // selected by `sheetSnapTargetH` — which the SnappingSheet pushes us
  // via `onSnapTargetChange` at the exact moment its own snap state
  // flips. During a finger drag we switch to imperative mode (no
  // transition) so the wheel tracks the pointer 1:1.
  const upperSnapH = screenHeight - 105; // matches SnappingSheet's snapPositions[2]
  // Solve wheel-state at any sheetHeight `h` (closed/midSnap/upper) — same
  // algebra as above but parameterised. Used to precompute the three
  // CSS-transition targets.
  const wheelStateAt = (h: number) => {
    const sp = isMobile ? Math.min(h / midSnap, 1) : 0;
    // Top reserve shrinks as the sheet opens (a 54px constant would dominate the
    // compressed area), but only GENTLY — the old 0.4 factor shrank it so far
    // below the 54px bar that the wheel rode up under it. 0.2 keeps the midSnap
    // wheel a touch smaller in exchange for breathing room above it.
    const appBarPad = APP_BAR_PAD * (1 - 0.1 * sp);
    const spinH = (isPlayMode || !showSpinButton) ? 0 : SPIN_H * Math.max(0, 1 - sp);
    const bottomCover = isPlayMode ? 0 : Math.max(RED_BASE, h);
    const hProg = (isMobile ? Math.max(0, 1 - sp) : 1) * (showSegmentHeader ? 1 : 0);
    const cHeader = (56 * activeConfig.headerTextSize) * hProg + 16 * hProg + 16;
    const avail = isMobile
      ? screenHeight - CHIP_H - appBarPad - spinH - bottomCover - cHeader
      : screenHeight - 100 - cHeader;
    const factor = 1 + WHEEL_PADDING_RATIO + HEADER_TEXT_PAD_RATIO * hProg;
    const size = Math.max(80, Math.min(avail / factor, effectiveWheelSize));
    const margin = isMobile
      ? Math.min(Math.max(0, h - RED_BASE), 450, Math.max(0, screenHeight - CHIP_H - RED_BASE - APP_BAR_PAD))
      : 0;
    const opacity = isMobile && h > midSnap
      ? Math.max(0, 1 - 2 * (h - midSnap) / (upperSnap - midSnap))
      : 1;
    // Lands a hair above appBarPad (as before) so the wheel clears the bar; 0.1
    // (was 0.3) keeps it from sliding up under the app bar at midSnap.
    const paddingTop = APP_BAR_PAD * (1 - 0.0 * sp);
    const topSpacerFlex = (1.0 + 0.5 * sp) * (1 - hProg);
    return { size, scale: size / effectiveWheelSize, margin, opacity, paddingTop, topSpacerFlex };
  };
  const closedWheelState = wheelStateAt(0);
  const midWheelState = wheelStateAt(midSnap);
  const upperWheelState = wheelStateAt(upperSnapH);
  const wheelStateForSnap = (h: number) =>
    h >= upperSnapH ? upperWheelState : h >= midSnap ? midWheelState : closedWheelState;
  // Which wheel state drives the JSX style this render:
  //   • during drag → live (derived from per-frame sheetHeight), zero
  //     CSS transition so the wheel tracks the finger 1:1
  //   • otherwise → the snap-target state (closed / mid / upper),
  //     and the CSS transition below interpolates to it
  // Freeze wheel sizing at the mid snap: from mid → upper the wheel stays
  // STATIC — no shrink, scale, or fade — and the rising sheet simply covers
  // it. Clamping the sizing input at midSnap means React re-renders with the
  // identical wheel style above mid (no DOM change → no wheel re-layout/paint),
  // which is cheaper and reads better than animating it out of view.
  const wheelStyleState = isSheetDragging
    ? wheelStateAt(Math.min(sheetHeight, midSnap))
    : wheelStateForSnap(Math.min(sheetSnapTargetH, midSnap));
  // Match the sheet's own height transition exactly so wheel + sheet
  // arrive at their targets on the same frame. `disableHeightTransition`
  // / drag both kill the transition for the cases where the sheet does
  // the same.
  // 0.28s + cubic-bezier(0.32, 0.72, 0, 1) — tighter than the prior
  // 0.45s + (0.16, 1, 0.3, 1) which had a long settling tail that read
  // as lag. Must stay in sync with the sheet's own transition (see
  // SnappingSheet.tsx) or wheel and sheet drift apart.
  const wheelTransitionCss = (isSheetDragging || skipSheetOpenAnim)
    ? 'none'
    : 'width 0.28s cubic-bezier(0.32, 0.72, 0, 1), height 0.28s cubic-bezier(0.32, 0.72, 0, 1), transform 0.28s cubic-bezier(0.32, 0.72, 0, 1), margin-bottom 0.28s cubic-bezier(0.32, 0.72, 0, 1), padding-top 0.28s cubic-bezier(0.32, 0.72, 0, 1), opacity 0.28s cubic-bezier(0.32, 0.72, 0, 1), flex-grow 0.28s cubic-bezier(0.32, 0.72, 0, 1)';

  // [SHEET-DBG] On every sheetHeight commit, measure the chip bar and
  // sheet's live bounding rects and log them. Dedups against the
  // last-logged sheetHeight + chipBar-top combo so frame-by-frame ticks
  // during a snap animation only log at points where SOMETHING actually
  // changed — but the initial measurement always logs.
  const lastDbgSigRef = useRef<string | null>(null);
  useEffect(() => {
    const chip = chipBarDbgRef.current?.getBoundingClientRect();
    const sheet = sheetDbgRef.current?.getBoundingClientRect();
    const chipTop = chip ? Math.round(chip.top * 10) / 10 : null;
    const sheetTop = sheet ? Math.round(sheet.top * 10) / 10 : null;
    const sig = `${Math.round(sheetHeight)}|${chipTop}|${sheetTop}`;
    if (sig === lastDbgSigRef.current) return;
    lastDbgSigRef.current = sig;
    // Flat log so the console doesn't collapse nested objects to {…}.
    const sB = sheet ? Math.round(sheet.bottom * 10) / 10 : null;
    const sH = sheet ? Math.round(sheet.height * 10) / 10 : null;
    const cB = chip ? Math.round(chip.bottom * 10) / 10 : null;
    const cH = chip ? Math.round(chip.height * 10) / 10 : null;
    // eslint-disable-next-line no-console
    console.log(`[SHEET-DBG] state=${sheetHeight} sheet[top=${sheetTop} bot=${sB} h=${sH}] chip[top=${chipTop} bot=${cB} h=${cH}] vp[innerH=${window.innerHeight} vvH=${window.visualViewport?.height ?? '∅'}] screenH=${screenHeight}`);
  }, [sheetHeight, screenHeight]);

  // Index of the active wheel within the flow (-1 if not in a flow).
  const flowIdx = flowSteps ? flowSteps.findIndex(s => s.id === block.id) : -1;
  // Jump to the previous (dir -1) / next (dir +1) wheel in the flow, with the
  // matching slide animation — same in-place swap the preview tiles use.
  const goToAdjacentWheel = (dir: -1 | 1) => {
    if (!flowSteps || flowIdx < 0) return;
    const targetIdx = flowIdx + dir;
    if (targetIdx < 0 || targetIdx >= flowSteps.length) return;
    const step = flowSteps[targetIdx];
    setOptimisticActiveId(step.id);
    flushAutoSave();
    setPreviewConfig(null);
    pendingConfigRef.current = null;
    setWheelTransition(dir > 0 ? 'right' : 'left');
    onSwitchActive?.(step);
  };
  // Side chevrons appear only while the sheet rests at the mid snap, on a
  // multi-wheel flow.
  const showSideChevrons = isMobile && flowSteps != null && flowSteps.length > 1 && sheetSnapTargetH === midSnap;

  return (
    <div style={{
      display: 'flex',
      height: '100dvh',
      backgroundColor: isEditMode && !isMobile ? BG : backgroundColor,
      overflow: 'hidden',
      // Slide the entire editor in/out from the bottom edge. slide-in-up
      // plays once on mount over the always-mounted AppShell underneath;
      // slide-out-down plays when the close X is pressed and the navigate
      // call is delayed by setTimeout to match this duration.
      animation: isClosing
        ? 'slide-out-down 0.26s cubic-bezier(0.32, 0.72, 0, 1) forwards'
        : 'slide-in-up 0.26s cubic-bezier(0.32, 0.72, 0, 1) both',
    }}>
      {/* Desktop sidebar editor */}
      {isEditMode && !isMobile && (
        <div style={{
          width: 400,
          borderRight: `1.5px solid ${BORDER}`,
          backgroundColor: SURFACE,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', padding: '8px 8px 0 8px' }}>
            <button onClick={() => navigate('/')} style={{ padding: 8 }}>
              <ArrowLeft size={24} />
            </button>
            <div style={{ flex: 1, marginLeft: 4 }}>
              <h2 style={{ fontSize: 22, fontWeight: 700, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {activeConfig.name}
              </h2>
            </div>
          </div>
          <div style={{ flex: 1, overflow: 'hidden' }}>
            <WheelEditor
              key={baseConfig.id}
              initialConfig={baseConfig}
              wheelId={block.id}
              history={wrappedEditorHistory}
              onPreview={handleWheelPreview}
              selectedTab={desktopTab}
              onTabChange={t => setDesktopTab(t === 0 ? 0 : 1)}
              showSegmentHeader={showSegmentHeader}
              onToggleSegmentHeader={setShowSegmentHeader}
            />
          </div>
        </div>
      )}

      {/* Wheel + sheet area */}
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        backgroundColor,
        overflow: 'hidden',
      }}>
        {/* App bar — fixed at top, always fully visible. */}
        <div style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          display: 'flex',
          alignItems: 'center',
          padding: '0 10px',
          zIndex: 10,
          height: 54,
        }}>
          <CircleIconButton
            ariaLabel="Close editor"
            onClick={() => {
              if (isClosing) return; // ignore double-taps during the exit animation
              flushAutoSave();
              setIsClosing(true);
              // Wait for the slide-out-down animation to finish before
              // navigating, so the user actually sees the editor slide off
              // the bottom. Duration matches the keyframe (260ms).
              setTimeout(() => {
                if (window.history.length > 1) {
                  navigate(-1);
                } else {
                  sessionStorage.removeItem('appShellTab');
                  navigate('/');
                }
              }, 260);
            }}
          >
            <X size={22} color="#FFFFFF" strokeWidth={2.5} />
          </CircleIconButton>
          <div style={{ flex: 1, display: 'flex', justifyContent: 'center', minWidth: 0, padding: '0 6px' }}>
          <AppBarTitleInput
            value={titleIsFlow ? flowExperience!.name : editorHistory.state.name}
            placeholder={titleIsFlow ? 'Flow name' : 'Wheel name'}
            onLiveChange={(name) => {
              if (titleIsFlow) {
                // Multi-wheel flow: patch the experience through flow history so
                // other views (profile, preview tiles) re-render this frame.
                flowHistory.patch({ experience: { ...flowExperience!, name } });
                flowDirtyRef.current = true;
              } else {
                // Standalone OR one-wheel flow: the wheel name IS the title (the
                // sync effect mirrors it onto a one-step flow's experience).
                editorHistory.patch({ name });
                editorDirtyRef.current = true;
              }
              syncOpFlags();
            }}
            onCommit={() => {
              if (titleIsFlow) {
                flowHistory.commit();
                if (flowDirtyRef.current) {
                  flowDirtyRef.current = false;
                  pushOp('flow');
                }
              } else {
                editorHistory.commit();
                if (editorDirtyRef.current) {
                  editorDirtyRef.current = false;
                  pushOp('editor');
                }
              }
            }}
          />
          </div>
          <div style={{ display: 'flex', gap: 8, minWidth: 44, justifyContent: 'flex-end' }}>
            {isPlayMode && (
              <CircleIconButton ariaLabel="Stop" onClick={() => setIsPlayMode(false)}>
                <Square size={20} color="#FFFFFF" fill="#FFFFFF" strokeWidth={2.5} />
              </CircleIconButton>
            )}
            {!isPlayMode && onRequestPublish && (
              <CircleIconButton ariaLabel="Publish & settings" onClick={() => { flushAutoSave(); onRequestPublish(); }}>
                <Share2 size={22} color="#FFFFFF" strokeWidth={2.5} />
              </CircleIconButton>
            )}
          </div>
        </div>

        {/* Stack child 1 — flex column holding app bar + wheel + red container.
            Takes all vertical space above the chip bar (which is sibling 2).
            The red container's height grows with sheetHeight, so the wheel
            (sandwiched between flex spacers) shrinks as the sheet rises.
            paddingTop reserves space for the absolute-positioned app bar. */}
        <div ref={wheelAreaRef} style={{
          flex: 1,
          position: 'relative',
          minHeight: 0,
          // Scales down with sheet open progress so the constant
          // APP_BAR_PAD doesn't dominate the top of a compressed
          // wheel area — when the sheet is open the wheel header is
          // hidden anyway, so the wheel canvas can sit closer to the
          // app bar and the top space stops being lopsided vs bottom.
          // Driven by snap-target like the wheel itself so the whole
          // area moves in lockstep, not piecewise.
          paddingTop: wheelStyleState.paddingTop,
          paddingBottom: isMobile ? 0 : bottomControlsHeight,
          // When the sheet rises past the red box, push the wheel area up so
          // the spin button stays above the sheet's top edge instead of being
          // covered. Driven by the snap target (not live sheetHeight) so the
          // browser CSS-transitions it in lockstep with the sheet's own
          // height transition — see `wheelTransitionCss` below.
          marginBottom: wheelStyleState.margin,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          opacity: wheelStyleState.opacity,
          overflow: 'hidden',
          transition: wheelTransitionCss,
        }}>
          {/* Side wheel-nav chevrons — only while the sheet rests at mid snap
              on a multi-wheel flow. Vertically centred on the wheel area, at
              the screen edges; fade via opacity so the snap stays smooth. */}
          {isMobile && flowSteps && flowSteps.length > 1 && flowIdx > 0 && (
            <button
              onClick={() => goToAdjacentWheel(-1)}
              aria-label="Previous wheel"
              style={{
                position: 'absolute', top: '50%', left: 8, transform: 'translateY(-50%)',
                zIndex: 5, width: 42, height: 42, borderRadius: 999, border: 'none',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                backgroundColor: 'transparent',
                cursor: 'pointer',
                opacity: showSideChevrons ? 1 : 0,
                pointerEvents: showSideChevrons ? 'auto' : 'none',
                transition: 'opacity 0.2s ease',
              }}
            >
              <ChevronLeft size={38} color={ON_SURFACE} strokeWidth={2.5} />
            </button>
          )}
          {isMobile && flowSteps && flowSteps.length > 1 && flowIdx >= 0 && flowIdx < flowSteps.length - 1 && (
            <button
              onClick={() => goToAdjacentWheel(1)}
              aria-label="Next wheel"
              style={{
                position: 'absolute', top: '50%', right: 8, transform: 'translateY(-50%)',
                zIndex: 5, width: 42, height: 42, borderRadius: 999, border: 'none',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                backgroundColor: 'transparent',
                cursor: 'pointer',
                opacity: showSideChevrons ? 1 : 0,
                pointerEvents: showSideChevrons ? 'auto' : 'none',
                transition: 'opacity 0.2s ease',
              }}
            >
              <ChevronRight size={38} color={ON_SURFACE} strokeWidth={2.5} />
            </button>
          )}
          {/* Top spacer — slightly less flex than the bottom spacer so the
              wheel+header group sits a hair above the geometric center
              (which optically reads as centered). Snap-target driven +
              CSS-transitioned (flex-grow animates) so the wheel's
              in-area vertical centering moves in lockstep with the
              sheet, not in React-commit jumps. */}
          <div style={{ flexGrow: wheelStyleState.topSpacerFlex, transition: wheelTransitionCss }} />
          {/* Keyed wrapper forces a remount on block change so the CSS
              fade/scale animation re-fires each time the user switches
              wheel (or a new wheel is appended and navigated-to). */}
          <div
            key={block.id}
            onAnimationStart={(e) => {
              // eslint-disable-next-line no-console
              console.log(`[WheelCanvas] animation START name=${e.animationName} block=${block.id} wheelTransition=${wheelTransition ?? '∅'}`);
            }}
            onAnimationEnd={(e) => {
              // eslint-disable-next-line no-console
              console.log(`[WheelCanvas] animation END   name=${e.animationName} block=${block.id}`);
            }}
            style={{
              animation: wheelTransition === 'right'
                ? 'slide-in-from-right 0.28s cubic-bezier(0.32, 0.72, 0, 1) both'
                : wheelTransition === 'left'
                  ? 'slide-in-from-left 0.28s cubic-bezier(0.32, 0.72, 0, 1) both'
                  : 'wheel-fade-in 0.28s cubic-bezier(0.22, 0.61, 0.36, 1)',
            }}
          >
            {/* Outer is HORIZONTALLY constant (width = effectiveWheelSize)
                so flex `alignItems: center` re-centering can't wobble as
                the wheel shrinks — width never changes, so the centered
                position is fixed. Outer HEIGHT still transitions so the
                vertical spacers compensate smoothly. Inner scales with
                `top center` origin so visible content shrinks toward the
                outer's horizontal centerline (matching the constant flex
                centering) and toward the outer's top (so the visible
                bottom edge equals outer.height — keeping vertical in
                sync with the height transition). */}
            <div ref={wheelOuterRef} style={{
              width: effectiveWheelSize,
              height: wheelStyleState.size,
              position: 'relative',
              transition: wheelTransitionCss,
            }}>
            <div ref={wheelInnerRef} style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: effectiveWheelSize,
              height: effectiveWheelSize,
              transform: `scale(${wheelStyleState.scale})`,
              transformOrigin: 'top center',
              transition: wheelTransitionCss,
            }}>
            <SpinningWheel
              ref={wheelRef}
              items={activeConfig.items}
              onFinished={onWheelFinished}
              size={effectiveWheelSize}
              textSizeMultiplier={activeConfig.textSize}
              headerTextSizeMultiplier={activeConfig.headerTextSize}
              imageSize={activeConfig.imageSize * staticScale}
              cornerRadius={activeConfig.cornerRadius * staticScale}
              innerCornerStyle={activeConfig.innerCornerStyle}
              centerInset={activeConfig.centerInset * staticScale}
              strokeWidth={activeConfig.strokeWidth * staticScale}
              outerStrokeWidth={(activeConfig.outerStrokeWidth ?? 0) * staticScale}
              outerStrokeDots={activeConfig.outerStrokeDots}
              bezelDotsColorMode={activeConfig.bezelDotsColorMode}
              bezelDotsCustomColor={activeConfig.bezelDotsCustomColor}
              textWrap={activeConfig.textWrap}
              showBackgroundCircle={activeConfig.showBackgroundCircle}
              wheelBaseColor={activeConfig.wheelBaseColor}
              markerDiameter={activeConfig.markerDiameter}
              markerPeek={activeConfig.markerPeek}
              markerBaseColor={activeConfig.markerBaseColor}
              tickSound={activeConfig.tickSound}
              resultDialog={activeConfig.resultDialog}
              spinIntensity={spinIntensity}
              isRandomIntensity={isRandomIntensity}
              headerTextColor={textColor}
              overlayColor={overlayColor}
              showWinAnimation={showWinAnimation}
              headerOpacity={(isMobile ? Math.max(0, 1 - spacerProgress) : 1) * (showSegmentHeader ? 1 : 0)}
              headerSizeProgress={(isMobile ? Math.max(0, 1 - spacerProgress) : 1) * (showSegmentHeader ? 1 : 0)}
              headerCanvasGap={showSpinButton && showSegmentHeader ? 28 : 16}
              headerTransition={wheelTransitionCss}
              onSegmentLongPress={idx => {
                // Open the segments sheet and queue a scroll to the
                // tapped segment. WheelEditor's effect picks up the
                // index, scrolls there, and clears the pending state.
                setPendingScrollSegment(idx);
                openSheetTo('segments');
              }}
            />
            </div>
            </div>
          </div>
          {/* Bottom spacer — slightly larger flex than the top spacer
              (optical centering when sheet is closed), scaled down by
              the same factor as paddingTop so the bottom space shrinks
              in step with the top when the sheet compresses the area.
              CSS-transitioned in lockstep with the rest of the wheel
              area so it animates via the compositor (no React render). */}
          <div style={{ flexGrow: 1.8 + 0.4 * spacerProgress, transition: wheelTransitionCss }} />
          {/* Spin button — pinned to bottom of wheel section, animates
              via CSS in lockstep with the sheet/wheel. Hidden entirely
              when the user disables it from Settings. */}
          {showSpinButton && (
            <div style={{
              width: '100%',
              padding: '0 32px',
              flexShrink: 0,
              opacity: Math.max(0, 1 - spacerProgress),
              height: 54 * Math.max(0, 1 - spacerProgress),
              marginBottom: 12 * Math.max(0, 1 - spacerProgress),
              overflow: 'hidden',
              transition: wheelTransitionCss,
            }}>
              {/* Matches the Add Segment button's style (rounded, 3px stroke,
                  height 54), but keeps SPIN's larger 24px label. */}
              <PushDownButton color={PRIMARY} onTap={() => wheelRef.current?.spin()} borderRadius={32} innerStrokeWidth={3} height={54} bottomBorderWidth={6}>
                <span style={{ color: '#FFF', fontSize: 24, fontWeight: 800, letterSpacing: 2 }}>SPIN</span>
              </PushDownButton>
            </div>
          )}

        </div>

          {/* Red container — fixed height (not flexible), sibling of the
              wheel area, pinned above the chip bar. The sheet overlays both
              the wheel area and red as a group via fixed positioning. */}
          <div style={{
            flexShrink: 0,
            width: '100%',
            height: redBoxHeight,
            opacity: isPlayMode ? 0 : 1,
            backgroundColor: SURFACE,
            // visible (not hidden) so the pop-in scale and grabbed box-shadow
            // can extend past the red box without being clipped.
            overflow: 'visible',
            transition: 'height 0.3s ease, opacity 0.3s ease',
            display: 'flex',
            flexDirection: 'column',
            // Center the preview row vertically inside the red box.
            justifyContent: 'center',
            padding: '12px 0 11px',
            boxSizing: 'border-box',
          }}>
            {/* Preview row: [wheel 1] … [wheel N] [+ icon].
                flexShrink: 0 keeps the row at its intrinsic height (≈110
                for tile + gap + label) so red's flex column doesn't squish
                it down to red's padding box. Without this, the row would
                gain a forced vertical scrollbar and break centering. */}
            <div
              ref={previewRowRef}
              className="no-scrollbar"
              onMouseDown={handleRowMouseDown}
              onWheel={handleRowWheel}
              style={{
                display: 'flex',
                flexShrink: 0,
                gap: 10,
                minWidth: 0,
                // Lock horizontal scroll while a tile is being dragged —
                // on touch devices, native pan would otherwise slide the
                // row under the user's finger, throwing off hit-testing
                // and the drop indicator. Re-enables on release.
                overflowX: grabbedIndex !== null ? 'hidden' : 'auto',
                touchAction: grabbedIndex !== null ? 'none' : undefined,
                // Setting overflow-x to anything but visible forces overflow-y
                // to clip per CSS spec — that crops the grabbed tile's scale
                // halo + shadow during reorder. Top padding clears that halo.
                padding: '34px 14px 13px 14px',
                cursor: 'grab',
              }}
            >
              {flowSteps && flowSteps.length > 0 ? (
                flowSteps.map((step, idx) => {
                  const isActive = step.id === effectiveActiveId;
                  // `isCurrent` is the still-real selection (used for things
                  // tied to the actually-loaded wheel state — preview items,
                  // header label — which haven't been swapped yet during an
                  // optimistic-active window).
                  const isCurrent = step.id === block.id;
                  const items = step.wheelConfig?.items ?? [];
                  const previewItems = isCurrent ? activeConfig.items : items;
                  const wheelLabel = (isCurrent ? activeConfig.name : step.wheelConfig?.name) || step.name;
                  // Live rename — called on every keystroke. Active wheel uses
                  // editorHistory.patch so typing fills a single undo entry
                  // instead of flooding one-per-keystroke; non-active wheels
                  // write through onBlockUpdated so the app-wide view is
                  // instantly consistent.
                  const onRenameWheel = (newName: string) => {
                    if (isActive) {
                      editorHistory.patch({ name: newName });
                    } else if (step.wheelConfig) {
                      onBlockUpdated?.({
                        ...step,
                        name: newName,
                        wheelConfig: { ...step.wheelConfig, name: newName },
                      });
                    }
                  };
                  // Seal the undo entry on blur.
                  const onRenameCommit = () => {
                    if (isActive) editorHistory.commit();
                  };
                  // On touch-primary devices, tapping the label opens the
                  // rename sheet directly. With a mouse/trackpad, it focuses
                  // the inline input — and for non-active wheels it also
                  // navigates so edits land on the right one.
                  const onLabelFocus = isTouchPrimary
                    ? () => openRenameSheet(idx)
                    : (isCurrent ? undefined : () => {
                        setOptimisticActiveId(step.id);
                        flushAutoSave();
                        // See onClick handler above for why we clear
                        // previewConfig synchronously on a wheel swap.
                        setPreviewConfig(null);
                        pendingConfigRef.current = null;
                        const fromIdx = flowSteps?.findIndex(s => s.id === block.id) ?? -1;
                        setWheelTransition(idx > fromIdx ? 'right' : 'left');
                        // Local in-place swap — host swaps `block` directly,
                        // no navigate / route-state hop / BlockScreen useEffect.
                        onSwitchActive?.(step);
                      });
                  return (
                    <TileWithLabel
                      key={step.id}
                      label={wheelLabel}
                      editable={!isTouchPrimary}
                      onLabelEdit={onRenameWheel}
                      onLabelCommit={onRenameCommit}
                      onLabelFocus={onLabelFocus}
                      // Wrapper ref is what FLIP animates on reorder (sliding
                      // non-grabbed neighbors into their new slots). The
                      // inner PreviewTile keeps its own React-managed
                      // transform so the lift+scale aren't overwritten.
                      wrapperRef={el => { tileElsRef.current[idx] = el; }}
                    >
                      <PreviewTile
                        index={idx}
                        active={isActive}
                        grabbed={grabbedIndex === idx && !isSettling}
                        dragOffsetX={grabbedIndex === idx ? dragOffsetX : computeSlotOffset(idx)}
                        instantTransform={isCommitting}
                        skipPopIn={seenTileIds.has(step.id)}
                        debugId={step.id}
                        onClick={isCurrent ? () => {
                          // Tapping the already-selected tile opens the
                          // context menu (which has an "Edit wheel" action
                          // at the top to jump into the Segments sheet).
                          setCtxMenuIndex(idx);
                        } : () => {
                          dbg('RouletteScreen', 'tile:tap', {
                            from: sid(block.id),
                            to: sid(step.id),
                            flowExp: sid(flowExperience?.id ?? null),
                            flowSteps: sids(flowSteps),
                          });
                          // Optimistic highlight — paint the tapped tile as
                          // active *this frame*. Cleared automatically once
                          // block.id catches up.
                          setOptimisticActiveId(step.id);
                          flushAutoSave();
                          // Clear previewConfig synchronously with the block
                          // swap. Without this, the previous wheel's preview
                          // (set by WheelEditor's useEffect while editing
                          // the old wheel) survives into the post-tap commit
                          // — and because `wheelConfig.id` is stable across
                          // wheels in this data, activeConfig's id-match
                          // check still picks the stale previewConfig, so
                          // the new tile briefly shows the OLD wheel's items.
                          setPreviewConfig(null);
                          pendingConfigRef.current = null;
                          const fromIdx = flowSteps?.findIndex(s => s.id === block.id) ?? -1;
                          setWheelTransition(idx > fromIdx ? 'right' : 'left');
                          // Local in-place swap — BlockScreen swaps `block`
                          // directly. No navigate, no route-state hop, no
                          // BlockScreen useEffect → setBlock → re-render
                          // round-trip. The URL stays at the entry block.
                          onSwitchActive?.(step);
                        }}
                        onContextOpen={() => setCtxMenuIndex(idx)}
                        onGrabStart={handleGrabStart}
                        shouldSuppressClick={shouldSuppressTileClick}
                      >
                        <WheelThumbnail
                          items={previewItems}
                          size={72}
                          style={(() => {
                            const cfg = isCurrent ? activeConfig : step.wheelConfig;
                            return cfg ? {
                              strokeWidth: cfg.strokeWidth,
                              outerStrokeWidth: cfg.outerStrokeWidth,
                              outerStrokeDots: cfg.outerStrokeDots,
                              showBackgroundCircle: cfg.showBackgroundCircle,
                              wheelBaseColor: cfg.wheelBaseColor,
                              cornerRadius: cfg.cornerRadius,
                              innerCornerStyle: cfg.innerCornerStyle,
                              centerInset: cfg.centerInset,
                              markerDiameter: cfg.markerDiameter,
                              markerPeek: cfg.markerPeek,
                              markerBaseColor: cfg.markerBaseColor,
                            } : undefined;
                          })()}
                          debugLabel={`tile#${idx}/${sid(step.id)}/curr=${isCurrent}`}
                        />
                      </PreviewTile>
                    </TileWithLabel>
                  );
                })
              ) : (
                <TileWithLabel
                  label={activeConfig.name || block.name}
                  editable={!isTouchPrimary}
                  onLabelEdit={name => editorHistory.patch({ name })}
                  onLabelCommit={() => editorHistory.commit()}
                  onLabelFocus={isTouchPrimary ? () => openRenameSheet(0) : undefined}
                >
                  <PreviewTile
                    active
                    skipPopIn={seenTileIds.has(block.id)}
                    debugId={block.id}
                    onClick={() => setCtxMenuIndex(0)}
                    onContextOpen={() => setCtxMenuIndex(0)}
                  >
                    <WheelThumbnail
                      items={activeConfig.items}
                      size={72}
                      style={{
                        strokeWidth: activeConfig.strokeWidth,
                        outerStrokeWidth: activeConfig.outerStrokeWidth,
                        outerStrokeDots: activeConfig.outerStrokeDots,
                        showBackgroundCircle: activeConfig.showBackgroundCircle,
                        wheelBaseColor: activeConfig.wheelBaseColor,
                        cornerRadius: activeConfig.cornerRadius,
                        innerCornerStyle: activeConfig.innerCornerStyle,
                        centerInset: activeConfig.centerInset,
                        markerDiameter: activeConfig.markerDiameter,
                        markerPeek: activeConfig.markerPeek,
                        markerBaseColor: activeConfig.markerBaseColor,
                      }}
                      debugLabel={`solo/${sid(block.id)}`}
                    />
                  </PreviewTile>
                </TileWithLabel>
              )}
              <TileWithLabel label="">
              {/* The add tile is the one tile that's a real PushDownButton —
                  it presses down on tap. The wheel tiles above stay the
                  static 3D PreviewTiles (they grab/scale for reorder instead
                  of pressing). Sized to match a tile exactly: 88×88 face,
                  92 total (4px bottom-face peek), 13 radius, 3px stroke,
                  SURFACE_ELEVATED — same deriveCardSurfaces recipe a tile
                  uses, so at rest it's pixel-identical. */}
              <PushDownButton
                color={SURFACE_ELEVATED}
                borderRadius={13}
                height={92}
                bottomBorderWidth={4}
                innerStrokeWidth={3}
                style={{ width: 88, flexShrink: 0 }}
                onTap={() => {
                  if (!user) { dbg('RouletteScreen', 'plus:no-user'); return; }
                  dbg('RouletteScreen', 'plus:click', {
                    currentBlock: sid(block.id),
                    flowExp: sid(flowExperience?.id ?? null),
                    flowStepsLen: flowSteps?.length ?? 0,
                  });
                  flushAutoSave();

                  let change;
                  try {
                    change = buildAppendWheelChange({
                      currentBlock: { ...block, wheelConfig: activeConfig } as CloudBlock,
                      experience: flowExperience,
                      // Inherit the CURRENT wheel's vibe — colour the new wheel's
                      // slices from the vibe the selected tile matches. No match
                      // (custom palette) → fall back to the first vibe in order.
                      newWheelColors: (matchedVibe(activeConfig.items.map(it => it.color)) ?? firstOrderedVibe()).palette,
                    });
                  } catch (e) {
                    dbg('RouletteScreen', 'plus:build-fail', { err: e instanceof Error ? e.message : String(e) });
                    alert(e instanceof Error ? e.message : 'Failed to add wheel.');
                    return;
                  }

                  // Build the resulting snapshot (same as the old inline logic).
                  const nextSteps: CloudBlock[] = flowSteps && flowSteps.length > 0
                    ? [...flowSteps, change.newBlock]
                    : [
                        { ...(block as CloudBlock), wheelConfig: activeConfig, parentExperienceId: change.experience.id },
                        change.newBlock,
                      ];

                  // Route through flow history so the append is undoable.
                  commitFlowSet({ experience: change.experience, steps: nextSteps });

                  // When this press wraps a standalone wheel into a new flow,
                  // the current block's parentExperienceId changes. Tell App
                  // so its in-memory blocks list reflects it.
                  const stampedCurrent = change.writes.find(w => w.id === block.id);
                  if (stampedCurrent) onBlockUpdated?.(stampedCurrent);

                  // Navigate to the newly-added wheel so the center preview
                  // animates in via the keyed wrapper. replace: true keeps
                  // the history stack tidy.
                  navigate(`/block/${change.newBlock.id}`, {
                    replace: true,
                    state: {
                      block: change.newBlock,
                      editMode: true,
                      flowExperience: change.experience,
                      flowSteps: nextSteps,
                    },
                  });
                }}
              >
                <div
                  aria-label="Add wheel"
                  style={{
                    width: 32,
                    height: 32,
                    backgroundColor: ON_SURFACE,
                    WebkitMaskImage: 'url(/images/addl.svg)',
                    WebkitMaskRepeat: 'no-repeat',
                    WebkitMaskSize: 'contain',
                    WebkitMaskPosition: 'center',
                    maskImage: 'url(/images/addl.svg)',
                    maskRepeat: 'no-repeat',
                    maskSize: 'contain',
                    maskPosition: 'center',
                  }}
                />
              </PushDownButton>
              </TileWithLabel>
            </div>

          </div>

        {/* Stack child 2 — pinned chip bar. Always visible, never moves.
            The sheet (bottomOffset: 48) snaps to its top edge. */}
        {isMobile && !isPlayMode && (
          <PinnedChipBar
            activeTab={sheetOpen ? currentSection : null}
            onChange={(key) => { if (sheetOpen && currentSection === key) closeSheet(); else openSheetTo(key); }}
            canUndo={editorHistory.canUndo || opCanUndo}
            canRedo={editorHistory.canRedo || opCanRedo}
            onUndo={unifiedUndo}
            onRedo={unifiedRedo}
            onPlay={() => setIsPlayMode(true)}
            innerRef={chipBarDbgRef}
          />
        )}

        {/* Unified snapping sheet — overlays the red container area. The
            chip bar sits beneath, so bottomOffset: 48 keeps the sheet from
            covering it. */}
        {isMobile && (
          <SnappingSheet
            bottomOffset={56}
            visible={sheetOpen}
            snapPositions={[0, isMobile ? 380 : 400, screenHeight - 105]}
            initialSnap={1}
            onCollapsed={() => {
              setSheetOpen(false);
              setSheetHeight(0);
            }}
            onHeightChange={handleSheetHeightChange}
            isDragLocked={isSheetDragLocked}
            outerRef={sheetDbgRef}
            keepAlive
            disableHeightTransition={skipSheetOpenAnim}
            onSnapTargetChange={(h, instant) => {
              if (instant) {
                // Match the sheet's instant snap (e.g. X-button close) by
                // briefly disabling the wheel transition so it jumps in
                // lockstep. Cleared on the next animation frame so later
                // opens/drags animate normally again.
                setSkipSheetOpenAnim(true);
                requestAnimationFrame(() => setSkipSheetOpenAnim(false));
              }
              setSheetSnapTargetH(h);
              // Also seed sheetHeight at the snap target — handle-
              // SheetHeightChange skips per-rAF ticks now, so without
              // this `spacerProgress`-driven things (SpinningWheel
              // header opacity, bottom spacer, spin button) would stay
              // pinned to the previous snap's value for the duration of
              // the CSS transition. Setting it here lands them at the
              // new snap's value in the same React commit as the
              // transition kicks off.
              setSheetHeight(h);
            }}
            onDragStart={() => { setIsSheetDragging(true); isSheetDraggingRef.current = true; }}
            onDragEnd={() => { setIsSheetDragging(false); isSheetDraggingRef.current = false; }}
          >
            {/* overflow-x: hidden clips the off-screen slide so the parent
                doesn't briefly horizontal-scroll during the animation. */}
            {/* Continuous scroll-spy column: Templates → (Slices + Style, stacked
                INSIDE WheelEditor) → Settings. Each section is tagged via the
                spy so the chips follow the scroll; tapping a chip scrolls here.
                overflow-x:hidden clips the off-screen slide of nested sheets. */}
            <div style={{ overflowX: 'hidden' }}>
              <section ref={spy.register('templates')}>
                <TemplatesPane
                  name={editorHistory.state.name}
                  onNameChange={(name) => wrappedEditorHistory.patch({ name })}
                  onNameCommit={() => wrappedEditorHistory.commit()}
                  sliceColors={editorHistory.state.segments.map(s => s.color)}
                  onApplyVibe={(v) => {
                    const cols = recolorWithVibe(v, editorHistory.state.segments.length);
                    wrappedEditorHistory.set({ ...editorHistory.state, segments: editorHistory.state.segments.map((s, i) => ({ ...s, color: cols[i] })) });
                  }}
                  onApplyIdea={(idea) => {
                    // Replace the whole wheel with the idea's themed set (title +
                    // slices), colouring the new slices with the ACTIVE vibe so
                    // Surprise me keeps whatever vibe is defined (not reset to classic).
                    const cols = recolorWithVibe(activeVibe(editorHistory.state.segments.map(s => s.color)), idea.options.length);
                    const segs = idea.options.map((text, i) => ({
                      id: crypto.randomUUID(),
                      text,
                      color: cols[i],
                      weight: 1,
                    }));
                    wrappedEditorHistory.set({ ...editorHistory.state, name: idea.title, segments: segs });
                  }}
                  onReorderActiveChange={handleEditorReorderingChange}
                />
              </section>
              {/* Slices + Style render stacked inside WheelEditor; it tags those
                  two section anchors via registerSection. */}
              <WheelEditor
                key={baseConfig.id}
                initialConfig={baseConfig}
                wheelId={block.id}
                history={wrappedEditorHistory}
                onPreview={handleWheelPreview}
                layout="stacked"
                registerSection={spy.registerEl}
                onReorderActiveChange={handleEditorReorderingChange}
                scrollToSegmentIndex={pendingScrollSegment}
                onScrollToSegmentConsumed={() => setPendingScrollSegment(null)}
                renderRows={sheetOpen}
                sheetHeight={sheetHeight}
                isMobile={isMobile}
                showSegmentHeader={showSegmentHeader}
                onToggleSegmentHeader={setShowSegmentHeader}
              />
              <section ref={spy.register('settings')}>
                <SettingsPane
                  isRandomIntensity={isRandomIntensity} onIsRandomIntensityChange={setIsRandomIntensity}
                  spinIntensity={spinIntensity} onSpinIntensityChange={setSpinIntensity}
                  showWinAnimation={showWinAnimation} onShowWinAnimationChange={setShowWinAnimation}
                  showSpinButton={showSpinButton} onShowSpinButtonChange={setShowSpinButton}
                />
              </section>
            </div>
          </SnappingSheet>
        )}

      </div>

      {/* Per-tile context menu (right-click / long-press on a preview tile) */}
      {ctxMenuIndex !== null && (
        <DraggableSheet maxWidth={9999} onClose={() => setCtxMenuIndex(null)}>
          <div style={{ padding: '0 20px 28px' }}>
            <h3 style={{ fontSize: 18, fontWeight: 800, textAlign: 'center', margin: '0 0 16px' }}>
              Wheel actions
            </h3>
            <CtxRow
              icon={<Pencil size={20} />}
              label="Edit wheel"
              onTap={() => {
                setCtxMenuIndex(null);
                openSheetTo('templates');
              }}
            />
            <CtxRow
              icon={<Copy size={20} />}
              label="Copy wheel"
              onTap={() => { const i = ctxMenuIndex; setCtxMenuIndex(null); runCtxAction('copy', i); }}
            />
            {canPasteWheel && (
              <CtxRow
                icon={<ClipboardPaste size={20} />}
                label="Paste wheel"
                onTap={() => { const i = ctxMenuIndex; setCtxMenuIndex(null); runCtxAction('paste', i); }}
              />
            )}
            <CtxRow
              icon={<CopyPlus size={20} />}
              label="Duplicate wheel"
              onTap={() => { const i = ctxMenuIndex; setCtxMenuIndex(null); runCtxAction('duplicate', i); }}
            />
            <CtxRow
              icon={<Trash2 size={20} />}
              label="Delete wheel"
              danger
              onTap={() => { const i = ctxMenuIndex; setCtxMenuIndex(null); runCtxAction('delete', i); }}
            />
          </div>
        </DraggableSheet>
      )}


{/* Rename wheel sheet — primary editing path on mobile. Each keystroke
          propagates live via onRenameDraftChange; the sheet just needs to
          close and seal the undo entry. */}
      {renameIndex !== null && (
        <DraggableSheet maxWidth={9999} onClose={closeRenameSheet}>
          <div style={{ padding: '0 20px 28px' }}>
            <h3 style={{ fontSize: 18, fontWeight: 800, textAlign: 'center', margin: '0 0 16px' }}>
              Rename wheel
            </h3>
            <input
              ref={renameInputRef}
              type="text"
              value={renameDraft}
              onChange={e => onRenameDraftChange(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') closeRenameSheet(); }}
              placeholder="Wheel name"
              style={{
                width: '100%',
                padding: '12px 14px',
                borderRadius: 14,
                border: `1.5px solid ${BORDER}`,
                // Dark-theme field (matches the WheelEditor inputs). Was a
                // stray light #F8F8F9 bg, which made the light ON_SURFACE text
                // nearly invisible and clashed with the rest of the sheet.
                backgroundColor: SURFACE_ELEVATED,
                fontSize: 16,
                fontWeight: 600,
                fontFamily: 'inherit',
                color: ON_SURFACE,
                outline: 'none',
                boxSizing: 'border-box',
                marginBottom: 14,
              }}
            />
            {/* Matches the Add Segment button's style (same PushDownButton
                params + label), just without a leading icon. */}
            <PushDownButton color={PRIMARY} onTap={closeRenameSheet} borderRadius={32} innerStrokeWidth={3} height={54} bottomBorderWidth={6}>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#FFFFFF',
              }}>
                <span style={{ fontWeight: 700, fontSize: 16 }}>Done</span>
              </div>
            </PushDownButton>
          </div>
        </DraggableSheet>
      )}

    </div>
  );
}

// Wraps a PreviewTile with a small wheel-name label below it. Tapping the
// label focuses an inline input so the user can rename that wheel, and also
// selects (activates) the wheel that owns the label so the edit targets the
// right one. Fixed height keeps the + tile aligned with named tiles.
function TileWithLabel({ label, editable, onLabelEdit, onLabelCommit, onLabelFocus, wrapperRef, children }: {
  label: string;
  // When false (mobile), the label is a display-only clickable div — tapping
  // navigates to the parent wheel but doesn't start an inline edit. Renaming
  // happens via the context menu → rename sheet.
  editable?: boolean;
  // Fires on every keystroke. Parent is responsible for using a cheap
  // propagation mechanism (editor history patch for the active wheel, a
  // full block update for others) so updates are instant.
  onLabelEdit?: (name: string) => void;
  // Fires on blur — lets the parent seal the history entry (commit).
  onLabelCommit?: () => void;
  onLabelFocus?: () => void;
  // Optional wrapper ref so the parent can FLIP-animate this tile's whole
  // (preview + label) box without fighting the inner PreviewTile's React-
  // managed transform/transition styles.
  wrapperRef?: (el: HTMLDivElement | null) => void;
  children: React.ReactNode;
}) {
  const [draft, setDraft] = useState(label);
  useEffect(() => { setDraft(label); }, [label]);
  const onDraftChange = (value: string) => {
    setDraft(value);
    const trimmed = value.trim();
    if (!trimmed) return;
    onLabelEdit?.(trimmed);
  };
  const commonStyle: React.CSSProperties = {
    width: 88,
    height: 18,
    fontSize: 11,
    fontWeight: 600,
    color: withAlpha(ON_SURFACE, 0.75),
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    textAlign: 'center',
    lineHeight: '18px',
  };
  const isEditable = editable && !!onLabelEdit;
  return (
    <div
      ref={wrapperRef}
      style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, flexShrink: 0 }}
    >
      {children}
      {isEditable ? (
        <input
          type="text"
          value={draft}
          onChange={e => onDraftChange(e.target.value)}
          onFocus={onLabelFocus}
          onBlur={onLabelCommit}
          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          style={{
            ...commonStyle,
            padding: 0,
            border: 'none',
            outline: 'none',
            background: 'transparent',
            fontFamily: 'inherit',
            cursor: 'text',
          }}
        />
      ) : (
        <div
          onClick={onLabelFocus}
          style={{ ...commonStyle, cursor: onLabelFocus ? 'pointer' : 'default' }}
        >
          {label}
        </div>
      )}
    </div>
  );
}

// Top app-bar title: edits the flow name when editing a step of a flow, or
// the wheel's own name when the block is standalone. Live-commits each
// keystroke so downstream views (preview tiles, profile, etc.) update
// immediately; onCommit seals the undo entry on blur.
function AppBarTitleInput({
  value, placeholder, onLiveChange, onCommit,
}: {
  value: string;
  placeholder: string;
  onLiveChange: (name: string) => void;
  onCommit: () => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  const onChange = (next: string) => {
    setDraft(next);
    const trimmed = next.trim();
    if (!trimmed || trimmed === value) return;
    onLiveChange(trimmed);
  };
  return (
    <input
      type="text"
      value={draft}
      onChange={e => onChange(e.target.value)}
      onBlur={onCommit}
      placeholder={placeholder}
      // `size` tracks the text length so the pill hugs its content (capped by
      // maxWidth so a long name can't shove the side buttons off the bar).
      size={Math.max((draft || placeholder).length, 4)}
      style={{
        maxWidth: '100%',
        minWidth: 0,
        boxSizing: 'border-box',
        height: 44,
        padding: '0 18px',
        fontSize: 17,
        fontWeight: 800,
        fontFamily: 'inherit',
        textAlign: 'center',
        color: '#FFFFFF',
        background: 'rgba(255,255,255,0.06)',
        border: '1.5px solid rgba(255,255,255,0.22)',
        borderRadius: 999,
        outline: 'none',
        cursor: 'text',
      }}
    />
  );
}

// Circular outlined icon button for the top app bar (close / stop / share),
// matching the reference's bezel-circle look.
function CircleIconButton({ onClick, ariaLabel, children }: {
  onClick?: () => void;
  ariaLabel: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={ariaLabel}
      style={{
        width: 44,
        height: 44,
        borderRadius: '50%',
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 0,
        background: 'rgba(255,255,255,0.06)',
        border: '1.5px solid rgba(255,255,255,0.22)',
        cursor: 'pointer',
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      {children}
    </button>
  );
}

// Chip bar that lives as a normal flex child at the bottom of the game
// container — rides up with the container when the sheet opens.
function PinnedChipBar({
  activeTab,
  onChange,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onPlay,
  innerRef,
}: {
  activeTab: 'segments' | 'style' | 'settings' | 'templates' | null;
  onChange: (t: 'segments' | 'style' | 'settings' | 'templates') => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onPlay: () => void;
  innerRef?: React.MutableRefObject<HTMLDivElement | null>;
}) {
  // Set true if the chip row's scrollLeft changes between pointerdown
  // and click. Used by onClickCapture to swallow the click so a
  // horizontal scroll (mouse drag OR touch pan) doesn't ALSO activate
  // whichever chip the gesture started on.
  const didScrollRef = useRef(false);
  // Each item maps a tab key to its SVG icon path. The icons are rendered
  // as CSS masks (via the SvgMaskIcon helper below) so a single asset
  // can be tinted any colour — supports the active/inactive chip colours.
  const items: { key: 'segments' | 'style' | 'settings' | 'templates'; label: string; iconSrc: string }[] = [
    { key: 'templates', label: 'Templates', iconSrc: '/images/template.svg' },
    { key: 'segments', label: 'Slices', iconSrc: '/images/segments.svg' },
    { key: 'style', label: 'Style', iconSrc: '/images/style.svg' },
    { key: 'settings', label: 'Settings', iconSrc: '/images/settings.svg' },
  ];
  // ── Bar spacing recipe ────────────────────────────────────────────────
  // Bar height: 56px. alignItems: 'flex-end' bottom-aligns every child so
  // each button's `marginBottom` directly defines its own bottom spacing,
  // and the top spacing falls out as `56 − height − marginBottom`.
  //
  // The pattern: smaller buttons sit lower (more breathing above), larger
  // buttons sit higher (less breathing above). Top is always 2px less than
  // bottom for the same button (optical lift). Re-use these values in any
  // new bottom-bar with PushDown buttons:
  //
  //   Button         total H   marginBottom   → top / bottom space
  //   Chip pill      38        10               8  / 10
  //   Round (38)     42         8               6  /  8
  //   Round (42)     46         6               4  /  6
  //
  // To resize the bar, keep `(56 − height − marginBottom)` symmetric across
  // buttons (i.e. shift all marginBottoms by the same delta as the bar).
  // ──────────────────────────────────────────────────────────────────────
  return (
    <div
      ref={el => { if (innerRef) innerRef.current = el; }}
      style={{
      flexShrink: 0,
      width: '100%',
      height: 56,
      display: 'flex',
      alignItems: 'flex-end',
      gap: 4,
      padding: 0,
      backgroundColor: SURFACE,
      borderTop: `3px solid rgba(0, 0, 0, 0.2)`,
      boxSizing: 'border-box',
      // Stack above red so red can never bleed into the chip's footprint.
      position: 'relative',
      zIndex: 5,
    }}>
      <div
        className="no-scrollbar"
        onPointerDownCapture={() => { didScrollRef.current = false; }}
        onScroll={() => { didScrollRef.current = true; }}
        onClickCapture={e => {
          if (didScrollRef.current) {
            e.stopPropagation();
            e.preventDefault();
            didScrollRef.current = false;
          }
        }}
        onWheel={e => {
          if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
            e.currentTarget.scrollLeft += e.deltaY;
            e.preventDefault();
          }
        }}
        onMouseDown={e => {
          if (e.button !== 0) return;
          const row = e.currentTarget;
          const startX = e.clientX;
          const startScrollLeft = row.scrollLeft;
          let didDrag = false;
          const onMove = (me: MouseEvent) => {
            const dx = me.clientX - startX;
            if (!didDrag && Math.abs(dx) > 4) didDrag = true;
            if (didDrag) row.scrollLeft = startScrollLeft - dx;
          };
          const onUp = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
          };
          window.addEventListener('mousemove', onMove);
          window.addEventListener('mouseup', onUp);
        }}
        style={{
          display: 'flex',
          gap: 4,
          minWidth: 0,
          overflowX: 'auto',
          overflowY: 'visible',
          flex: 1,
          cursor: 'grab',
          paddingLeft: 14,
          // Stepped right-edge fade — 2 rectangular bands (~14px each)
          // at 66% / 33% opacity, replacing the smooth gradient for a
          // more pixel-styled look that matches the rest of the chunky-
          // block UI.
          WebkitMaskImage:
            'linear-gradient(to right, #000 0, #000 calc(100% - 29px), rgba(0,0,0,0) 100%)',
          maskImage:
            'linear-gradient(to right, #000 0, #000 calc(100% - 29px), rgba(0,0,0,0) 100%)',
        }}
      >
        {items.map(({ key, label, iconSrc }) => {
          const isActive = activeTab === key;
          // Templates renders icon-only (no label) — a compact square chip.
          const iconOnly = key === 'templates';
          // Active chip = light surface (ON_SURFACE) → dark text (BG).
          // Inactive chip = dark surface (SURFACE_ELEVATED) → light text.
          const iconColor = isActive ? BG : withAlpha(ON_SURFACE, 0.85);
          return (
            <PushDownButton
              key={key}
              onTap={() => onChange(key)}
              color={isActive ? ON_SURFACE : SURFACE_ELEVATED}
              borderRadius={26}
              height={38}
              bottomBorderWidth={4}
              innerStrokeWidth={3}
              style={{ flexShrink: 0, marginBottom: 8 }}
            >
              <div style={{
                display: 'flex',
                alignItems: 'center',
                color: iconColor,
                fontWeight: 700,
                fontSize: 16,
                whiteSpace: 'nowrap',
              }}>
                <div style={{
                  width: 30,
                  height: 29,
                  // Padding lives on the ICON, not the button's content
                  // box — keeps the button's own bounds tight and gives
                  // the icon its own left breathing room. Icon flush
                  // against the label (no right margin). Icon-only chips
                  // get symmetric horizontal margin so they read square.
                  marginLeft: iconOnly ? 5 : 7,
                  marginRight: iconOnly ? 5 : 0,
                  backgroundColor: iconColor,
                  WebkitMaskImage: `url(${iconSrc})`,
                  WebkitMaskRepeat: 'no-repeat',
                  WebkitMaskSize: 'contain',
                  WebkitMaskPosition: 'center',
                  maskImage: `url(${iconSrc})`,
                  maskRepeat: 'no-repeat',
                  maskSize: 'contain',
                  maskPosition: 'center',
                  flexShrink: 0,
                }} />
                {!iconOnly && <span style={{ marginRight: 12 }}>{label}</span>}
              </div>
            </PushDownButton>
          );
        })}
        {/* Trailing 20px spacer — gives the chip row a little extra scroll
            headroom past the last chip so the user can flick the row
            slightly further than the chip itself. */}
        <div style={{ width: 20, flexShrink: 0 }} />
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 5, flexShrink: 0, paddingRight: 14 }}>
        <PushDownButton
          onTap={canUndo ? onUndo : undefined}
          color={SURFACE_ELEVATED}
          borderRadius={50}
          height={42}
          bottomBorderWidth={4}
          innerStrokeWidth={3}
          style={{ width: 38, marginBottom: 6 }}
        >
          <div style={{
            width: 22,
            height: 22,
            backgroundColor: ON_SURFACE,
            opacity: canUndo ? 1 : 0.35,
            WebkitMaskImage: 'url(/images/undo.svg)',
            WebkitMaskRepeat: 'no-repeat',
            WebkitMaskSize: 'contain',
            WebkitMaskPosition: 'center',
            maskImage: 'url(/images/undo.svg)',
            maskRepeat: 'no-repeat',
            maskSize: 'contain',
            maskPosition: 'center',
          }} />
        </PushDownButton>
        <PushDownButton
          onTap={canRedo ? onRedo : undefined}
          color={SURFACE_ELEVATED}
          borderRadius={50}
          height={42}
          bottomBorderWidth={4}
          innerStrokeWidth={3}
          style={{ width: 38, marginBottom: 6 }}
        >
          <div style={{
            width: 22,
            height: 22,
            backgroundColor: ON_SURFACE,
            opacity: canRedo ? 1 : 0.35,
            WebkitMaskImage: 'url(/images/redo.svg)',
            WebkitMaskRepeat: 'no-repeat',
            WebkitMaskSize: 'contain',
            WebkitMaskPosition: 'center',
            maskImage: 'url(/images/redo.svg)',
            maskRepeat: 'no-repeat',
            maskSize: 'contain',
            maskPosition: 'center',
          }} />
        </PushDownButton>
        <PushDownButton
          onTap={onPlay}
          color={PRIMARY}
          borderRadius={50}
          height={46}
          bottomBorderWidth={4}
          innerStrokeWidth={3}
          style={{ width: 42, marginLeft: 8, marginBottom: 6 }}
        >
          <div style={{
            width: 22,
            height: 22,
            // Optical-center fix: a play triangle's visual mass sits on
            // the left edge, so a geometrically-centered icon reads as
            // shifted right. ~2px nudge to the right balances the eye.
            marginLeft: 3,
            backgroundColor: '#FFFFFF',
            WebkitMaskImage: 'url(/images/playl.svg)',
            WebkitMaskRepeat: 'no-repeat',
            WebkitMaskSize: 'contain',
            WebkitMaskPosition: 'center',
            maskImage: 'url(/images/playl.svg)',
            maskRepeat: 'no-repeat',
            maskSize: 'contain',
            maskPosition: 'center',
          }} />
        </PushDownButton>
      </div>
    </div>
  );
}

function CtxRow({ icon, label, onTap, danger }: {
  icon: React.ReactNode;
  label: string;
  onTap: () => void;
  danger?: boolean;
}) {
  // Content (icon + label) inherits this colour via currentColor; the
  // surface stays SURFACE_ELEVATED so Delete reads as red text on the same
  // neutral button rather than a red fill (matches the prior row look).
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
      {/* Full-width child so the centred top face still lays the icon +
          label out left-aligned, like the menu rows these replaced. */}
      <div style={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        paddingLeft: 16,
        color: contentColor,
      }}>
        {icon}
        <span style={{ fontWeight: 700, fontSize: 15 }}>{label}</span>
      </div>
    </PushDownButton>
  );
}

// ── Red-footer subcomponents ─────────────────────────────────────────────

function PreviewTile({
  onClick, onContextOpen, onGrabStart,
  index, active, grabbed, dragOffsetX = 0, instantTransform, innerRef, shouldSuppressClick, skipPopIn, debugId, children,
}: {
  onClick?: () => void;
  // Right-click handler (no hold required).
  onContextOpen?: () => void;
  // Fires when the 500ms long-press threshold is met and the finger is still
  // down. Parent takes over the pointer from here via window listeners.
  onGrabStart?: (index: number, startX: number, startY: number) => void;
  index?: number;
  active?: boolean;
  // True when this tile is the one currently being dragged in a reorder.
  // Driven by parent state since the grabbed position shifts as tiles swap.
  grabbed?: boolean;
  // Live pointer-follow offset (parent-managed). Applied as translateX so
  // the grabbed tile glides under the user's finger between slot swaps.
  dragOffsetX?: number;
  // When true, transform changes are applied with no transition for one
  // frame. Used during the post-settle commit so the natural-position
  // shift from the array reorder doesn't trigger a parallel transform
  // animation (which would visibly bounce past the resting spot).
  instantTransform?: boolean;
  // Callback ref so parent can collect a { index -> element } map for
  // midpoint hit-testing during reorder.
  innerRef?: (el: HTMLDivElement | null) => void;
  // Returns true if the click should be ignored — used to skip tile navigate
  // immediately after a row drag-to-scroll mouse gesture.
  shouldSuppressClick?: () => boolean;
  // When true, skip the tile-pop-in entrance animation. Used so existing
  // wheels don't re-pop when the standalone-tile JSX is replaced by the
  // flow-tile JSX (e.g. on the very first +-add).
  skipPopIn?: boolean;
  // Step id (or "+" for the add tile) — passed only so mount/unmount
  // logs can identify which wheel a tile represents across remounts.
  debugId?: string;
  children: React.ReactNode;
}) {
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didLongPressRef = useRef(false);
  const startPosRef = useRef<{ x: number; y: number } | null>(null);
  // Standalone fallback: when there is no reorder handler (no flow), a
  // long-press still needs to open the context menu on release.
  const primedForContextRef = useRef(false);
  // Local grabbed state — driven by this tile's own long-press activation.
  // For flow tiles the parent also passes `grabbed`, which wins; for
  // standalone tiles (no parent state), this is the only source.
  const [isGrabbedLocal, setIsGrabbedLocal] = useState(false);
  // Tap press — the top face dips onto the peek + lights up (PushDownButton feel).
  const [pressed, setPressed] = useState(false);
  // Mount / unmount tracing — distinguishes "React preserved the instance
  // and re-rendered" (no log) from "React unmounted the old and mounted a
  // new" (UNMOUNT then MOUNT log).
  const tileInstanceIdRef = useRef(Math.random().toString(36).slice(2, 6));
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.log(`[Tile#${tileInstanceIdRef.current}] MOUNT idx=${index} debugId=${debugId ?? '?'}`);
    return () => {
      // eslint-disable-next-line no-console
      console.log(`[Tile#${tileInstanceIdRef.current}] UNMOUNT idx=${index} debugId=${debugId ?? '?'}`);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const effectiveGrabbed = !!grabbed || isGrabbedLocal;

  const clearLongPress = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  return (
    <div
      ref={el => { innerRef?.(el); }}
      onClick={() => {
        if (didLongPressRef.current) {
          didLongPressRef.current = false;
          return;
        }
        if (shouldSuppressClick?.()) return;
        onClick?.();
      }}
      onContextMenu={onContextOpen ? (e => {
        e.preventDefault();
        e.stopPropagation();
        onClick?.();
        clearLongPress();
        didLongPressRef.current = true;
        onContextOpen();
      }) : undefined}
      onPointerDown={(onGrabStart || onContextOpen) ? (e => {
        if (e.button === 2) return;
        didLongPressRef.current = false;
        primedForContextRef.current = false;
        setPressed(true);
        startPosRef.current = { x: e.clientX, y: e.clientY };
        longPressTimerRef.current = setTimeout(() => {
          didLongPressRef.current = true;
          longPressTimerRef.current = null;
          setPressed(false); // hand off to the lift/scale grab visual
          // Only fire onClick on activation for NON-active tiles — there it
          // means "switch to this wheel" before entering reorder. For the
          // already-active tile, onClick = "open context menu," which we
          // only want on tap or release, never mid-hold.
          if (!active) onClick?.();
          if (index !== undefined && onGrabStart) {
            // Flow tile: parent owns the grabbed visual via its grabbedIndex
            // (which it clears when the auto-menu fires). Don't also set a
            // local flag — otherwise the tile stays scaled after the sheet
            // auto-opens because local state doesn't reset until pointerup.
            const start = startPosRef.current;
            onGrabStart(index, start?.x ?? 0, start?.y ?? 0);
          } else if (onContextOpen) {
            // Standalone — no reorder. Local flag drives the visual; release
            // without drag opens the context menu (no time-based auto-open).
            setIsGrabbedLocal(true);
            primedForContextRef.current = true;
          }
        }, 300);
      }) : undefined}
      onPointerMove={(onGrabStart || onContextOpen) ? (e => {
        if (!startPosRef.current) return;
        const dx = e.clientX - startPosRef.current.x;
        const dy = e.clientY - startPosRef.current.y;
        if (Math.hypot(dx, dy) > 8) { clearLongPress(); setPressed(false); }
      }) : undefined}
      onPointerUp={(onGrabStart || onContextOpen) ? (() => {
        clearLongPress();
        setPressed(false);
        setIsGrabbedLocal(false);
        if (primedForContextRef.current) {
          primedForContextRef.current = false;
          onContextOpen?.();
        }
      }) : undefined}
      onPointerCancel={(onGrabStart || onContextOpen) ? (() => {
        clearLongPress();
        setPressed(false);
        setIsGrabbedLocal(false);
        primedForContextRef.current = false;
      }) : undefined}
      style={{
        width: 88,
        height: 92,
        position: 'relative',
        borderRadius: 13,
        flexShrink: 0,
        cursor: onClick ? 'pointer' : 'default',
        // Pop-in animation fires on initial mount (tile added or sheet opened),
        // but is suppressed for tiles whose wheel id was already on screen —
        // prevents the existing first wheel from re-popping when the JSX
        // path swaps from standalone-tile to flow-tile on the first +-add.
        animation: skipPopIn ? undefined : 'tile-pop-in 0.32s cubic-bezier(0.34, 1.56, 0.64, 1)',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        // Suppress the iOS long-press callout (copy/save/select) that
        // otherwise fires on top of our own long-press gesture.
        WebkitTouchCallout: 'none',
        // While grabbed (long-press active), kill native touch pan so the
        // row doesn't scroll under the user's finger during reorder/menu-hold.
        touchAction: effectiveGrabbed ? 'none' : 'manipulation',
        // Always keep `transform` in the transition list — only the
        // duration toggles (0s while grabbed so the live pointer-follow
        // is instant; 0.22s otherwise). If transition-property itself
        // were swapped between grabbed and not-grabbed, the same-commit
        // value change on release would land before the new transition
        // list activates, and the tile would snap instead of glide.
        // `instantTransform` overrides duration to 0s for one frame
        // during the post-settle reorder commit.
        transition: (effectiveGrabbed || instantTransform)
          ? 'transform 0s, box-shadow 0.12s ease'
          : 'transform 0.22s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.12s ease',
        // Grabbed tile follows the pointer in real time (translateX tracks
        // the finger, no transition so it's instant). Non-grabbed tiles use
        // dragOffsetX as a slot-shift indicator: while a sibling is being
        // dragged across them, neighbors slide one slot in the appropriate
        // direction to open an empty drop spot at the eventual landing.
        transform: effectiveGrabbed
          ? `translateX(${dragOffsetX}px) scale(1.08)`
          : `translateX(${dragOffsetX}px) scale(1)`,
        boxShadow: effectiveGrabbed ? '0 6px 16px rgba(0,0,0,0.35)' : 'none',
        zIndex: effectiveGrabbed ? 2 : undefined,
      }}
    >
      {/* Active tiles use PRIMARY (the same light-blue as the Add
          segment button) so the selection reads colour-first; inactive
          tiles stay on SURFACE_ELEVATED. */}
      {(() => {
        const surfaces = deriveCardSurfaces(active ? PRIMARY : SURFACE_ELEVATED);
        return (
          <>
            {/* Bottom layer — peeks out 4px below the top face. */}
            <div style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 0,
              height: 88,
              borderRadius: 13,
              backgroundColor: surfaces.bottom,
              boxShadow: `0 0 0 3.5px ${surfaces.halo}`,
            }} />
            {/* Top layer — the face. Presses DOWN onto the peek + lights up on
                tap; drops 2px of the 4px peek so a sliver of the lower layer
                stays and the tile keeps reading as solid. */}
            <div style={{
              position: 'relative',
              height: 88,
              width: 88,
              borderRadius: 13,
              backgroundColor: surfaces.top,
              border: `3px solid ${surfaces.innerStroke}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxSizing: 'border-box',
              transform: pressed ? 'translateY(2px)' : 'translateY(0)',
              filter: pressed ? 'brightness(1.12)' : undefined,
              transition: 'transform 0.1s ease, filter 0.1s ease',
            }}>
              {children}
            </div>
          </>
        );
      })()}
      {/* Selection is indicated by the active tile's PRIMARY colour fill
          (above) — no floating pointer above the tile. */}
    </div>
  );
}

function Chip({ icon, label, onTap, muted }: {
  icon: React.ReactNode;
  label: string;
  onTap: () => void;
  muted?: boolean;
}) {
  return (
    <button
      onClick={onTap}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '8px 14px',
        borderRadius: 22,
        border: 'none',
        backgroundColor: muted ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.22)',
        color: '#FFFFFF',
        fontWeight: 700,
        fontSize: 13,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        opacity: muted ? 0.55 : 1,
      }}
    >
      {icon}
      {label}
    </button>
  );
}

function IconButton({ onClick, disabled, children }: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        width: 36, height: 36,
        borderRadius: 50,
        backgroundColor: 'rgba(255,255,255,0.15)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.35 : 1,
        border: 'none',
        transition: 'opacity 0.15s',
      }}
    >
      {children}
    </button>
  );
}
