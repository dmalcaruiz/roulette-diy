import { useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Block, WheelConfig } from '../models/types';
import SpinningWheel, { SpinningWheelHandle } from '../components/SpinningWheel';
import WheelEditor, { buildInitialState, EditorState, stateToConfig } from '../components/WheelEditor';
import { PushDownButton } from '../components/PushDownButton';
import { withAlpha, oklchShadow } from '../utils/colorUtils';
import { ON_SURFACE, PRIMARY, BORDER, BG, SURFACE, SURFACE_ELEVATED } from '../utils/constants';
import { ArrowLeft, Shuffle, Sparkles, Play, Square, X, Undo2, Redo2, Plus, LayoutList, Paintbrush, Settings as SettingsIcon, LayoutGrid, Type, Trash2, Copy, Pencil, Share2 } from 'lucide-react';
import DraggableSheet from '../components/DraggableSheet';
import SnappingSheet from '../components/SnappingSheet';
import { useHistory } from '../hooks/useHistory';
import WheelThumbnail from '../components/WheelThumbnail';
import { useAuth } from '../contexts/AuthContext';
import {
  buildAppendWheelChange, buildInsertWheelChange, buildDuplicateWheelChange,
  buildRemoveWheelChange,
} from '../services/flowService';
import { deleteDraft, saveDraft, type CloudBlock } from '../services/blockService';
import { dbg, sid, sids } from '../utils/debugLog';

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
  // Unified sheet — all four panes (segments, style, settings, templates)
  // share the same SnappingSheet and are switched by a chip header at the
  // top. null = sheet closed.
  type SheetTab = 'segments' | 'style' | 'settings' | 'templates';
  const SHEET_TAB_ORDER: SheetTab[] = ['segments', 'style', 'settings', 'templates'];
  const [sheetTab, setSheetTab] = useState<SheetTab | null>(null);
  // Direction of the most recent tab change — drives the slide-in animation
  // for the sheet body so chip switches feel like sideways navigation.
  const [tabSlideDir, setTabSlideDir] = useState<'left' | 'right' | null>(null);
  const prevSheetTabRef = useRef<SheetTab | null>(null);
  const setSheetTabAnimated = useCallback((next: SheetTab | null) => {
    const prev = prevSheetTabRef.current;
    if (next && prev && next !== prev) {
      const prevIdx = SHEET_TAB_ORDER.indexOf(prev);
      const nextIdx = SHEET_TAB_ORDER.indexOf(next);
      setTabSlideDir(nextIdx > prevIdx ? 'right' : 'left');
    } else {
      setTabSlideDir(null);
    }
    prevSheetTabRef.current = next;
    setSheetTab(next);
    // When closing via the chip path (tapping the active chip), match the
    // X button behavior: reset sheetHeight immediately so the wheel grows
    // back to its full size in step with the sheet sliding down. Without
    // this, the wheel-area sizing only catches up via SnappingSheet's
    // height-polling rAF, which occasionally lands short and leaves the
    // wheel smaller than its open-screen baseline.
    if (next === null) setSheetHeight(0);
  }, []);
  // Context menu triggered by right-click / long-press on a preview tile.
  // Holds the index of the tile that opened it. null = closed.
  const [ctxMenuIndex, setCtxMenuIndex] = useState<number | null>(null);
  // Mobile rename sheet — replaces inline label-editing on touch devices.
  // Holds the preview-tile index being renamed. null = closed.
  const [renameIndex, setRenameIndex] = useState<number | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
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
  // True while a segment-reorder gesture is active inside the WheelEditor.
  // Stored in a ref so the SnappingSheet can read it synchronously from
  // its pointer handlers — using state would lag by one render commit
  // and let the sheet drag a few px under the finger before the lock
  // engaged.
  const editorReorderingRef = useRef(false);
  const handleEditorReorderingChange = useCallback((active: boolean) => {
    editorReorderingRef.current = active;
  }, []);
  const isEditorReordering = useCallback(() => editorReorderingRef.current, []);
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
  const editorHistory = useHistory(buildInitialState(block.wheelConfig), handleHistoryChange, block.id);

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
  useEffect(() => {
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
  type CtxAction = 'delete' | 'duplicate' | 'insertBefore' | 'insertAfter';
  const runCtxAction = useCallback(async (action: CtxAction, index: number) => {
    if (!user) return;
    flushAutoSave();
    const currentBlock = { ...block, wheelConfig: activeConfig } as CloudBlock;
    const inFlow = !!(flowExperience && flowSteps && flowSteps.length > 0);

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
  }, [user, block, activeConfig, flowExperience, flowSteps, navigate, onFlowChange, onBlockUpdated, onBlockDelete, flushAutoSave]);

  // Dynamic wheel sizing — the wheel + sheet area is a flex column:
  //   child1 (flex:1): app bar + wheel + red container (red grows with sheet)
  //   child2 (flex-shrink:0, 48px): chip bar
  // Red container absorbs sheet height so the wheel shrinks in lockstep.
  const RED_BASE = 136;   // red container minimum (preview row + padding)
  const CHIP_H = 56;      // pinned chip bar
  const SPIN_H = 76;      // spin button + margin
  const APP_BAR_PAD = 54; // matches the always-visible app bar exactly
  const bottomControlsHeight = 96;
  const grabbingHeight = 30;
  const midSnap = 400;
  const spacerProgress = isMobile ? Math.min(sheetHeight / midSnap, 1) : 0;
  // App bar and spin button stay at constant size (always visible). The
  // wheel area between them shrinks as the sheet rises so the wheel still
  // resizes to fit.
  const appBarPadCurrent = APP_BAR_PAD;
  // Spin button collapses (height + margin + opacity) as the sheet opens,
  // and is removed entirely when the user disables it from Settings.
  const spinHCurrent = (isPlayMode || !showSpinButton) ? 0 : SPIN_H * Math.max(0, 1 - spacerProgress);
  // Red box's actual DOM height — fixed at RED_BASE (not flexible).
  const redBoxHeight = isPlayMode ? 0 : RED_BASE;
  // Effective bottom coverage used for wheel sizing — when the sheet is open
  // taller than the red box, the wheel must shrink to stay above the sheet
  // (the sheet visually covers both the red box and the bottom of the wheel
  // area, since they're siblings under a fixed-position overlay).
  const effectiveBottomCover = isPlayMode ? 0 : Math.max(RED_BASE, sheetHeight);
  // SpinningWheel renders header + 16 spacer + canvas + 16 bottom spacer.
  // The header is in flex flow so the (header + canvas) group is centered as
  // a unit between the app bar and spin button. Subtract its overhead so the
  // wheel is sized to leave room for it.
  const headerSizeProg = (isMobile ? Math.max(0, 1 - spacerProgress) : 1) * (showSegmentHeader ? 1 : 0);
  const wheelHeaderOverhead = ((56 * activeConfig.headerTextSize + 16) + 16) * headerSizeProg + 16;
  const wheelPadding = 20; // breathing room
  const availableForWheel = isMobile
    ? screenHeight - CHIP_H - appBarPadCurrent - spinHCurrent - effectiveBottomCover - wheelHeaderOverhead
    : screenHeight - 100 - wheelHeaderOverhead;
  const maxWheelSize = Math.min(availableForWheel - wheelPadding, effectiveWheelSize);
  const clampedWheelSize = Math.max(80, Math.min(maxWheelSize, effectiveWheelSize));
  const dynamicScale = clampedWheelSize / idealWheelSize;
  // Wheel fades out when sheet goes past mid snap toward full height
  const upperSnap = screenHeight - 80;
  const wheelOpacity = isMobile && sheetHeight > midSnap
    ? Math.max(0, 1 - 2 * (sheetHeight - midSnap) / (upperSnap - midSnap))
    : 1;

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
              history={wrappedEditorHistory}
              onPreview={handleWheelPreview}
              selectedTab={sheetTab === 'style' ? 1 : 0}
              onTabChange={t => setSheetTabAnimated(t === 0 ? 'segments' : 'style')}
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
          padding: '12px 8px',
          zIndex: 10,
          height: 54,
        }}>
          <button
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
            style={{ padding: 8, background: 'none', border: 'none', cursor: 'pointer' }}
            aria-label="Close editor"
          >
            <X size={32} color="#FFFFFF" strokeWidth={2.5} />
          </button>
          <AppBarTitleInput
            value={flowExperience ? flowExperience.name : editorHistory.state.name}
            placeholder={flowExperience ? 'Flow name' : 'Wheel name'}
            onLiveChange={(name) => {
              if (flowExperience) {
                // Patch the experience through flow history so other views
                // (profile, preview tiles) re-render this frame.
                flowHistory.patch({ experience: { ...flowExperience, name } });
                flowDirtyRef.current = true;
              } else {
                editorHistory.patch({ name });
                editorDirtyRef.current = true;
              }
              syncOpFlags();
            }}
            onCommit={() => {
              if (flowExperience) {
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
          <div style={{ display: 'flex', gap: 4 }}>
            {isPlayMode && (
              <button onClick={() => setIsPlayMode(false)} style={{ padding: 8 }} aria-label="Stop">
                <Square size={26} color="#FFFFFF" fill="#FFFFFF" strokeWidth={2.5} />
              </button>
            )}
            {!isPlayMode && onRequestPublish && (
              <button
                onClick={() => { flushAutoSave(); onRequestPublish(); }}
                style={{
                  padding: 8,
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                }}
                aria-label="Publish & settings"
              >
                <Share2 size={28} color="#FFFFFF" strokeWidth={2.5} />
              </button>
            )}
          </div>
        </div>

        {/* Stack child 1 — flex column holding app bar + wheel + red container.
            Takes all vertical space above the chip bar (which is sibling 2).
            The red container's height grows with sheetHeight, so the wheel
            (sandwiched between flex spacers) shrinks as the sheet rises.
            paddingTop reserves space for the absolute-positioned app bar. */}
        <div style={{
          flex: 1,
          position: 'relative',
          minHeight: 0,
          // Constant — reserves space for the always-visible app bar.
          paddingTop: APP_BAR_PAD,
          paddingBottom: isMobile ? 0 : bottomControlsHeight,
          // When the sheet rises past the red box, push the wheel area up so
          // the spin button stays above the sheet's top edge instead of being
          // covered. Capped at 450px so over-drag past the upper snap can't
          // shove the red+chip past the viewport bottom; the viewport-safety
          // min handles tiny viewports where 450 itself would overflow.
          marginBottom: isMobile
            ? Math.min(Math.max(0, sheetHeight - RED_BASE), 450, Math.max(0, screenHeight - CHIP_H - RED_BASE))
            : 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          opacity: wheelOpacity,
          overflow: 'hidden',
        }}>
          {/* Top spacer — slightly less flex than the bottom spacer so the
              wheel+header group sits a hair above the geometric center
              (which optically reads as centered). */}
          <div style={{ flex: 1 }} />
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
                ? 'slide-in-from-right 0.5s cubic-bezier(0.32, 0.72, 0, 1) both'
                : wheelTransition === 'left'
                  ? 'slide-in-from-left 0.5s cubic-bezier(0.32, 0.72, 0, 1) both'
                  : 'wheel-fade-in 0.28s cubic-bezier(0.22, 0.61, 0.36, 1)',
            }}
          >
            <SpinningWheel
              ref={wheelRef}
              items={activeConfig.items}
              onFinished={onWheelFinished}
              size={clampedWheelSize}
              textSizeMultiplier={activeConfig.textSize * dynamicScale}
              headerTextSizeMultiplier={activeConfig.headerTextSize * dynamicScale}
              imageSize={activeConfig.imageSize * dynamicScale}
              cornerRadius={activeConfig.cornerRadius * dynamicScale}
              innerCornerStyle={activeConfig.innerCornerStyle}
              centerInset={activeConfig.centerInset * dynamicScale}
              strokeWidth={activeConfig.strokeWidth * dynamicScale}
              showBackgroundCircle={activeConfig.showBackgroundCircle}
              centerMarkerSize={activeConfig.centerMarkerSize * dynamicScale}
              spinIntensity={spinIntensity}
              isRandomIntensity={isRandomIntensity}
              headerTextColor={textColor}
              overlayColor={overlayColor}
              showWinAnimation={showWinAnimation}
              headerOpacity={(isMobile ? Math.max(0, 1 - spacerProgress) : 1) * (showSegmentHeader ? 1 : 0)}
              headerSizeProgress={(isMobile ? Math.max(0, 1 - spacerProgress) : 1) * (showSegmentHeader ? 1 : 0)}
            />
          </div>
          {/* Bottom spacer — slightly larger flex than the top spacer to
              shift the wheel group up by a few px (optical centering). */}
          <div style={{ flex: 1.4 }} />
          {/* Spin button — pinned to bottom of wheel section, collapses
              instantly with the sheet drag (no transition lag). Hidden
              entirely when the user disables it from Settings. */}
          {showSpinButton && (
            <div style={{
              width: '100%',
              padding: '0 20px',
              flexShrink: 0,
              opacity: Math.max(0, 1 - spacerProgress),
              height: 64 * Math.max(0, 1 - spacerProgress),
              marginBottom: 12 * Math.max(0, 1 - spacerProgress),
              overflow: 'hidden',
            }}>
              <PushDownButton color={PRIMARY} onTap={() => wheelRef.current?.spin()}>
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
                // halo + shadow. Padding gives the lifted state room INSIDE
                // the row's content box so it never reaches the clip edge.
                // 16 top / 13 bottom — slight top weight nudges the previews
                // a touch below dead-center.
                padding: '16px 0 13px 14px',
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
                        <WheelThumbnail items={previewItems} size={72} />
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
                    <WheelThumbnail items={activeConfig.items} size={72} />
                  </PreviewTile>
                </TileWithLabel>
              )}
              <TileWithLabel label="">
              <PreviewTile
                skipPopIn={seenTileIds.has('__plus__')}
                debugId="+"
                onClick={() => {
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
              </PreviewTile>
              </TileWithLabel>
            </div>

          </div>

        {/* Stack child 2 — pinned chip bar. Always visible, never moves.
            The sheet (bottomOffset: 48) snaps to its top edge. */}
        {isMobile && !isPlayMode && (
          <PinnedChipBar
            activeTab={sheetTab}
            onChange={setSheetTabAnimated}
            canUndo={editorHistory.canUndo || opCanUndo}
            canRedo={editorHistory.canRedo || opCanRedo}
            onUndo={unifiedUndo}
            onRedo={unifiedRedo}
            onPlay={() => setIsPlayMode(true)}
          />
        )}

        {/* Unified snapping sheet — overlays the red container area. The
            chip bar sits beneath, so bottomOffset: 48 keeps the sheet from
            covering it. */}
        {isMobile && (
          <SnappingSheet
            bottomOffset={56}
            visible={sheetTab !== null}
            snapPositions={[0, 400, screenHeight - 105]}
            initialSnap={1}
            onCollapsed={() => { setSheetTab(null); setSheetHeight(0); }}
            onHeightChange={setSheetHeight}
            isDragLocked={isEditorReordering}
          >
            {/* overflow-x: hidden clips the off-screen slide so the parent
                doesn't briefly horizontal-scroll during the animation. */}
            <div style={{ overflowX: 'hidden' }}>
            {/* Keyed wrapper — remounts on chip change so the slide-in
                animation re-fires. Direction is set by setSheetTabAnimated
                based on the order of the chips. */}
            <div
              key={sheetTab ?? 'closed'}
              style={{
                animation: tabSlideDir === 'right'
                  ? 'slide-in-from-right 0.3s cubic-bezier(0.32, 0.72, 0, 1) both'
                  : tabSlideDir === 'left'
                    ? 'slide-in-from-left 0.3s cubic-bezier(0.32, 0.72, 0, 1) both'
                    : undefined,
              }}
            >
            {(sheetTab === 'segments' || sheetTab === 'style') && (
              <WheelEditor
                key={`${baseConfig.id}:${sheetTab}`}
                initialConfig={baseConfig}
                history={wrappedEditorHistory}
                onPreview={handleWheelPreview}
                selectedTab={sheetTab === 'segments' ? 0 : 1}
                onReorderActiveChange={handleEditorReorderingChange}
              />
            )}
            {sheetTab === 'settings' && (
              <div style={{ padding: '0 20px 24px' }}>
                <ToggleRow
                  label="Random Intensity"
                  icon={<Shuffle size={22} />}
                  value={isRandomIntensity}
                  onChange={setIsRandomIntensity}
                />
                <div style={{ height: 12 }} />
                {!isRandomIntensity && (
                  <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12, gap: 8 }}>
                    <span style={{ width: 100, fontWeight: 600, fontSize: 14, color: withAlpha(ON_SURFACE, 0.6) }}>Intensity</span>
                    <input
                      type="range"
                      min={0} max={1} step={0.05}
                      value={spinIntensity}
                      onChange={e => setSpinIntensity(parseFloat(e.target.value))}
                      style={{ flex: 1, accentColor: ON_SURFACE }}
                    />
                    <span style={{ width: 44, textAlign: 'right', fontWeight: 700, fontSize: 13 }}>
                      {Math.round(spinIntensity * 100)}%
                    </span>
                  </div>
                )}
                <ToggleRow
                  label="Win Effects"
                  icon={<Sparkles size={22} />}
                  value={showWinAnimation}
                  onChange={setShowWinAnimation}
                />
                <div style={{ height: 12 }} />
                <ToggleRow
                  label="Segment Header"
                  icon={<Type size={22} />}
                  value={showSegmentHeader}
                  onChange={setShowSegmentHeader}
                />
                <div style={{ height: 12 }} />
                <ToggleRow
                  label="Spin Button"
                  icon={<Play size={22} />}
                  value={showSpinButton}
                  onChange={setShowSpinButton}
                />
              </div>
            )}
            {sheetTab === 'templates' && (
              <div style={{ padding: '0 20px 32px', textAlign: 'center' }}>
                <p style={{ fontSize: 14, fontWeight: 500, color: withAlpha(ON_SURFACE, 0.55), margin: '12px 20px' }}>
                  Prebuilt wheels are coming soon. You'll be able to pick a
                  starter here and customize from there.
                </p>
              </div>
            )}
            </div>
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
              icon={<LayoutList size={20} />}
              label="Edit wheel"
              onTap={() => {
                setCtxMenuIndex(null);
                setSheetTab('segments');
              }}
            />
            <CtxRow
              icon={<Pencil size={20} />}
              label="Rename wheel"
              onTap={() => { const i = ctxMenuIndex; setCtxMenuIndex(null); openRenameSheet(i); }}
            />
            <CtxRow
              icon={<Copy size={20} />}
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
          <div style={{ padding: '0 24px 32px' }}>
            <h3 style={{ fontSize: 18, fontWeight: 800, textAlign: 'center', margin: '0 0 14px' }}>
              Rename wheel
            </h3>
            <input
              type="text"
              value={renameDraft}
              onChange={e => onRenameDraftChange(e.target.value)}
              autoFocus
              onKeyDown={e => { if (e.key === 'Enter') closeRenameSheet(); }}
              placeholder="Wheel name"
              style={{
                width: '100%',
                padding: '12px 14px',
                borderRadius: 14,
                border: `1.5px solid ${BORDER}`,
                backgroundColor: '#F8F8F9',
                fontSize: 16,
                fontWeight: 600,
                fontFamily: 'inherit',
                color: ON_SURFACE,
                outline: 'none',
                boxSizing: 'border-box',
                marginBottom: 14,
              }}
            />
            <PushDownButton color={PRIMARY} onTap={closeRenameSheet}>
              <span style={{ color: '#FFF', fontSize: 15, fontWeight: 800 }}>Done</span>
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
      style={{
        flex: 1,
        minWidth: 0,
        margin: '0 4px',
        padding: '4px 6px',
        fontSize: 20,
        fontWeight: 800,
        fontFamily: 'inherit',
        textAlign: 'center',
        color: '#FFFFFF',
        background: 'transparent',
        border: 'none',
        outline: 'none',
        cursor: 'text',
      }}
    />
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
}: {
  activeTab: 'segments' | 'style' | 'settings' | 'templates' | null;
  onChange: (t: 'segments' | 'style' | 'settings' | 'templates' | null) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onPlay: () => void;
}) {
  const items: { key: 'segments' | 'style' | 'settings' | 'templates'; label: string; Icon: typeof LayoutList }[] = [
    { key: 'segments', label: 'Segments', Icon: LayoutList },
    { key: 'style', label: 'Style', Icon: Paintbrush },
    { key: 'settings', label: 'Settings', Icon: SettingsIcon },
    { key: 'templates', label: 'Templates', Icon: LayoutGrid },
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
    <div style={{
      flexShrink: 0,
      width: '100%',
      height: 56,
      display: 'flex',
      alignItems: 'flex-end',
      gap: 12,
      padding: 0,
      backgroundColor: SURFACE,
      borderTop: `1px solid ${BORDER}`,
      boxSizing: 'border-box',
      // Stack above red so red can never bleed into the chip's footprint.
      position: 'relative',
      zIndex: 5,
    }}>
      <div
        className="no-scrollbar"
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
          WebkitMaskImage:
            'linear-gradient(to right, #000 0, #000 calc(100% - 29px), transparent 100%)',
          maskImage:
            'linear-gradient(to right, #000 0, #000 calc(100% - 29px), transparent 100%)',
        }}
      >
        {items.map(({ key, label, Icon }) => {
          const isActive = activeTab === key;
          return (
            <PushDownButton
              key={key}
              onTap={() => onChange(isActive ? null : key)}
              color={isActive ? ON_SURFACE : SURFACE_ELEVATED}
              borderRadius={26}
              height={38}
              bottomBorderWidth={4}
              style={{ flexShrink: 0, marginBottom: 10 }}
            >
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                padding: '0 17px',
                // Active chip = light surface (ON_SURFACE) → dark text (BG).
                // Inactive chip = dark surface (SURFACE_ELEVATED) → light text.
                color: isActive ? BG : withAlpha(ON_SURFACE, 0.85),
                fontWeight: 700,
                fontSize: 16,
                whiteSpace: 'nowrap',
              }}>
                <Icon size={17} />
                {label}
              </div>
            </PushDownButton>
          );
        })}
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 5, flexShrink: 0, paddingRight: 14 }}>
        <PushDownButton
          onTap={canUndo ? onUndo : undefined}
          color={SURFACE_ELEVATED}
          borderRadius={50}
          height={42}
          bottomBorderWidth={4}
          style={{ width: 38, marginBottom: 8 }}
        >
          <Undo2 size={19} color={ON_SURFACE} style={{ opacity: canUndo ? 1 : 0.35 }} />
        </PushDownButton>
        <PushDownButton
          onTap={canRedo ? onRedo : undefined}
          color={SURFACE_ELEVATED}
          borderRadius={50}
          height={42}
          bottomBorderWidth={4}
          style={{ width: 38, marginBottom: 8 }}
        >
          <Redo2 size={19} color={ON_SURFACE} style={{ opacity: canRedo ? 1 : 0.35 }} />
        </PushDownButton>
        <PushDownButton
          onTap={onPlay}
          color={PRIMARY}
          borderRadius={50}
          height={46}
          bottomBorderWidth={4}
          style={{ width: 42, marginLeft: 8, marginBottom: 6 }}
        >
          <Play size={20} color="#FFFFFF" fill="#FFFFFF" />
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
  const color = danger ? '#EF4444' : ON_SURFACE;
  return (
    <div
      onClick={onTap}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '14px 16px',
        borderRadius: 14,
        backgroundColor: SURFACE_ELEVATED,
        border: `1.5px solid ${BORDER}`,
        marginBottom: 8,
        cursor: 'pointer',
        color,
      }}
    >
      {icon}
      <span style={{ fontWeight: 700, fontSize: 15 }}>{label}</span>
    </div>
  );
}

function ToggleRow({ label, icon, value, onChange }: {
  label: string;
  icon: React.ReactNode;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div
      onClick={() => onChange(!value)}
      style={{
        display: 'flex',
        alignItems: 'center',
        padding: '14px 16px',
        borderRadius: 14,
        backgroundColor: value ? withAlpha(PRIMARY, 0.12) : SURFACE_ELEVATED,
        border: `1.5px solid ${value ? PRIMARY : BORDER}`,
        cursor: 'pointer',
        transition: 'all 0.18s',
      }}
    >
      <div style={{ color: value ? '#0EA5E9' : withAlpha(ON_SURFACE, 0.45) }}>{icon}</div>
      <span style={{
        flex: 1,
        marginLeft: 12,
        fontWeight: 700,
        fontSize: 15,
        color: value ? ON_SURFACE : withAlpha(ON_SURFACE, 0.5),
      }}>
        {label}
      </span>
      {/* Toggle switch */}
      <div style={{
        width: 44, height: 26,
        borderRadius: 13,
        backgroundColor: value ? PRIMARY : BORDER,
        display: 'flex',
        alignItems: 'center',
        padding: 2,
        justifyContent: value ? 'flex-end' : 'flex-start',
        transition: 'all 0.18s',
      }}>
        <div style={{
          width: 22, height: 22,
          borderRadius: '50%',
          backgroundColor: '#FFFFFF',
        }} />
      </div>
    </div>
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
        startPosRef.current = { x: e.clientX, y: e.clientY };
        longPressTimerRef.current = setTimeout(() => {
          didLongPressRef.current = true;
          longPressTimerRef.current = null;
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
        if (Math.hypot(dx, dy) > 8) clearLongPress();
      }) : undefined}
      onPointerUp={(onGrabStart || onContextOpen) ? (() => {
        clearLongPress();
        setIsGrabbedLocal(false);
        if (primedForContextRef.current) {
          primedForContextRef.current = false;
          onContextOpen?.();
        }
      }) : undefined}
      onPointerCancel={(onGrabStart || onContextOpen) ? (() => {
        clearLongPress();
        setIsGrabbedLocal(false);
        primedForContextRef.current = false;
      }) : undefined}
      style={{
        width: 88,
        height: 92,
        position: 'relative',
        borderRadius: 16,
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
      {/* Bottom layer — same 3D recipe as PushDownButton: a darker face
          peeks out 4px below the top layer, with a faint outer stroke
          (~25% alpha of the same shadow color) for the soft halo. */}
      <div style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        height: 88,
        borderRadius: 16,
        backgroundColor: oklchShadow(active ? PRIMARY : SURFACE),
        boxShadow: `0 0 0 3.5px ${oklchShadow(active ? PRIMARY : SURFACE)}40`,
      }} />
      {/* Top layer — the face. */}
      <div style={{
        position: 'relative',
        height: 88,
        width: 88,
        borderRadius: 16,
        backgroundColor: SURFACE,
        border: active ? `3px solid ${PRIMARY}` : `3px solid ${BORDER}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxSizing: 'border-box',
      }}>
        {children}
      </div>
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
