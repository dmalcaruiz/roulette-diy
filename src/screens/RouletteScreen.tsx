import { useState, useRef, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Block, WheelConfig } from '../models/types';
import SpinningWheel, { SpinningWheelHandle } from '../components/SpinningWheel';
import WheelEditor, { buildInitialState, EditorState, stateToConfig } from '../components/WheelEditor';
import { PushDownButton } from '../components/PushDownButton';
import { withAlpha } from '../utils/colorUtils';
import { ON_SURFACE, PRIMARY, BORDER } from '../utils/constants';
import { ArrowLeft, Shuffle, Sparkles, Play, X, Undo2, Redo2, Plus, LayoutList, Paintbrush, Settings as SettingsIcon, LayoutGrid, Type, Trash2, Copy, Pencil, Share2 } from 'lucide-react';
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
}

export default function RouletteScreen({
  block, editMode = false, onBlockUpdated, onRequestPublish,
  flowSteps, flowExperience, onFlowChange,
}: RouletteScreenProps) {
  const { user } = useAuth();
  const navigate = useNavigate();
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
  const [showSegmentHeader, setShowSegmentHeader] = useState(true);
  // Inner editor sheet starts closed. The user reveals it by tapping a chip
  // (Segments / Style / Settings) in the red footer. This keeps the overlay's
  // opening uncluttered — you see the wheel first, then choose to edit.
  const [showEditor, setShowEditor] = useState(false);
  const [showGearMenu, setShowGearMenu] = useState(false);
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
  const [editorTab, setEditorTab] = useState(0); // 0=Segments, 1=Style
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

  const handleFlowHistoryChange = useCallback((s: FlowHistState) => {
    const prev = appliedFlowRef.current;
    appliedFlowRef.current = s;
    onFlowChange?.(s.experience, s.steps);
    if (!user) return;
    const delta = computeFlowDelta(prev, s);
    if (delta.writes.length === 0 && delta.deletes.length === 0) return;
    // Route writes through onBlockUpdated so App.blocks (and thus Profile
    // list / feed) update immediately — not just Firestore. onBlockUpdated
    // internally does the saveDraft.
    for (const b of delta.writes) onBlockUpdated?.(b);
    // Deletes still go directly — App's block list would retain them until
    // the next reload, which is acceptable.
    for (const id of delta.deletes) {
      deleteDraft(user.uid, id).catch(err => dbg('RouletteScreen', 'flow-history:delete-fail', { err: String(err) }));
    }
  }, [user, onFlowChange, onBlockUpdated]);

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
  // Always-current refs so the window-level handlers created at grab-start
  // can see the latest flow state after subsequent swaps.
  const flowExperienceRef = useRef(flowExperience);
  const flowStepsRef = useRef(flowSteps);
  flowExperienceRef.current = flowExperience;
  flowStepsRef.current = flowSteps;

  const handleGrabStart = useCallback((sourceIndex: number, startX: number, startY: number) => {
    // Lock scroll: stop momentum glide + tear down any in-progress mouse
    // drag-to-scroll so the row freezes the moment the grab activates.
    cancelInertia();
    rowDragCleanupRef.current?.();
    const startFlowSteps = flowStepsRef.current;
    const startFlowExp = flowExperienceRef.current;
    if (!startFlowSteps || !startFlowExp) {
      // Standalone (no flow) — long-press still selects; no reorder possible.
      // Release behavior falls back to context menu via onContextOpen.
      return;
    }

    let currentSource = sourceIndex;
    let didMove = false;
    setGrabbedIndex(sourceIndex);
    dbg('RouletteScreen', 'reorder:start', { index: sourceIndex });

    const onMove = (me: PointerEvent) => {
      // Require a meaningful movement from the grab-start position before
      // we accept any swap. Without this, pressing near a tile's edge can
      // trigger an immediate swap from sub-pixel pointer jitter — which
      // then makes "long-press + release" commit a reorder instead of
      // opening the context menu.
      const dx = me.clientX - startX;
      const dy = me.clientY - startY;
      if (Math.hypot(dx, dy) < 10) return;
      const steps = flowStepsRef.current;
      const exp = flowExperienceRef.current;
      if (!steps || !exp?.experienceConfig) return;

      // Midpoint hit-test across the live tile refs.
      let target = steps.length - 1;
      const els = tileElsRef.current;
      for (let i = 0; i < steps.length; i++) {
        const el = els[i];
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        if (me.clientX < rect.left + rect.width / 2) {
          target = i;
          break;
        }
      }
      target = Math.max(0, Math.min(target, steps.length - 1));
      if (target === currentSource) return;

      const nextSteps = [...steps];
      const [movedStep] = nextSteps.splice(currentSource, 1);
      nextSteps.splice(target, 0, movedStep);

      const entries = exp.experienceConfig.steps;
      const nextEntries = [...entries];
      const [movedEntry] = nextEntries.splice(currentSource, 1);
      nextEntries.splice(target, 0, movedEntry);
      const nextExp: CloudBlock = {
        ...exp,
        experienceConfig: { ...exp.experienceConfig, steps: nextEntries },
      };

      currentSource = target;
      didMove = true;
      onFlowChange?.(nextExp, nextSteps);
      setGrabbedIndex(target);
    };

    const cleanup = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };

    const onUp = () => {
      dbg('RouletteScreen', 'reorder:onUp', { didMove, currentSource });
      cleanup();
      setGrabbedIndex(null);
      if (didMove) {
        const finalExp = flowExperienceRef.current;
        const finalSteps = flowStepsRef.current ?? [];
        if (finalExp) {
          commitFlowSet({ experience: finalExp, steps: finalSteps });
        }
      } else {
        dbg('RouletteScreen', 'ctx:open-via-reorder-up', { index: currentSource });
        setCtxMenuIndex(currentSource);
      }
    };

    const onCancel = () => {
      dbg('RouletteScreen', 'reorder:onCancel', { didMove, currentSource });
      cleanup();
      setGrabbedIndex(null);
      if (didMove) {
        const finalExp = flowExperienceRef.current;
        const finalSteps = flowStepsRef.current ?? [];
        if (finalExp) commitFlowSet({ experience: finalExp, steps: finalSteps });
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
          // Optimistic: navigate home immediately, persist in the background.
          navigate('/');
          deleteDraft(user.uid, block.id).catch(err => {
            dbg('RouletteScreen', 'ctx:delete:standalone-fail', { err: String(err) });
          });
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
  }, [user, block, activeConfig, flowExperience, flowSteps, navigate, onFlowChange, onBlockUpdated, flushAutoSave]);

  // Dynamic wheel sizing — shrinks as sheet grows, matching Flutter behavior.
  // bottomContentHeight reserves the vertical space used by the spin button
  // (~76px incl. margin) plus the red footer (250px) when the sheet is closed,
  // so the wheel shrinks enough to keep the footer fully on-screen.
  const bottomContentHeight = 326;
  const bottomControlsHeight = 96;
  const grabbingHeight = 30;
  const midSnap = 460;
  const spacerProgress = isMobile ? Math.min(sheetHeight / midSnap, 1) : 0;
  const wheelPadding = 140 - 110 * spacerProgress;
  const availableForWheel = isMobile
    ? screenHeight - Math.max(sheetHeight, bottomContentHeight)
    : screenHeight - 100;
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
      backgroundColor: isEditMode && !isMobile ? '#FFFFFF' : backgroundColor,
      overflow: 'hidden',
    }}>
      {/* Desktop sidebar editor */}
      {isEditMode && !isMobile && (
        <div style={{
          width: 400,
          borderRight: '1.5px solid #E4E4E7',
          backgroundColor: '#FFFFFF',
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
              selectedTab={editorTab}
              onTabChange={setEditorTab}
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
        {/* App bar — fades out as sheet rises */}
        <div style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          display: 'flex',
          alignItems: 'center',
          padding: '12px 8px',
          zIndex: 10,
          opacity: isMobile ? Math.max(0, 1 - sheetHeight / midSnap) : 1,
          height: isMobile ? 54 * Math.max(0, 1 - sheetHeight / midSnap) : 54,
          overflow: 'hidden',
          transition: sheetHeight === 0 ? 'opacity 0.3s, height 0.3s' : 'none',
        }}>
          <button
            onClick={() => {
              flushAutoSave();
              // Exit straight out of the publish+overlay stack back to the
              // screen that invoked it (Profile, Feed, etc.) — skipping the
              // publish screen. When there's no prior history (deep link),
              // fall back to the Feed tab on home (clear the remembered tab
              // so we don't land on Profile by accident).
              if (window.history.length > 1) {
                navigate(-1);
              } else {
                sessionStorage.removeItem('appShellTab');
                navigate('/');
              }
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
              <button onClick={() => setIsPlayMode(false)} style={{ padding: 8 }}>
                <X size={32} color="#FFFFFF" />
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

        {/* Game container — height shrinks as sheet grows.
            paddingTop reserves space for the absolute-positioned app bar so
            the flex column centers the wheel (or the header+wheel group) in
            the visible area between app bar and spin button, not the whole
            container. Fades in lockstep with the app bar as the sheet rises. */}
        <div style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: isMobile ? sheetHeight : bottomControlsHeight,
          paddingTop: isMobile
            ? 40 * Math.max(0, 1 - sheetHeight / midSnap) + 16 * spacerProgress
            : 40,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          opacity: wheelOpacity,
        }}>
          {/* Top spacer — centers wheel */}
          <div style={{ flex: 1 }} />
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
          {/* Bottom spacer — centers wheel */}
          <div style={{ flex: 1 }} />
          {/* Spin button pinned to bottom — fades & collapses when sheet opens or play mode */}
          <div style={{
            width: '100%',
            padding: '0 20px',
            flexShrink: 0,
            opacity: Math.max(0, 1 - spacerProgress),
            height: 64 * Math.max(0, 1 - spacerProgress),
            marginBottom: 12 * Math.max(0, 1 - spacerProgress),
            overflow: 'hidden',
            transition: 'opacity 0.3s, height 0.3s, margin-bottom 0.3s',
          }}>
            <PushDownButton color={PRIMARY} onTap={() => wheelRef.current?.spin()}>
              <span style={{ color: '#FFF', fontSize: 24, fontWeight: 800, letterSpacing: 2 }}>SPIN</span>
            </PushDownButton>
          </div>
          {/* Bottom controls container — flex column:
              [play / undo-redo] [+  wheel preview] [chips] */}
          <div style={{
            flexShrink: 0,
            width: '100%',
            height: isPlayMode ? 0 : 250,
            opacity: isPlayMode ? 0 : 1,
            backgroundColor: 'red',
            overflow: 'hidden',
            transition: 'height 0.3s ease, opacity 0.3s ease',
            display: 'flex',
            flexDirection: 'column',
            padding: '12px 16px 14px',
            gap: 10,
            boxSizing: 'border-box',
          }}>
            {/* Header row: play (left) · undo/redo (right) */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <button
                onClick={() => setIsPlayMode(true)}
                style={{ padding: 8, background: 'none', border: 'none', cursor: 'pointer' }}
              >
                <Play size={24} color="#FFFFFF" fill="#FFFFFF" />
              </button>
              <div style={{ display: 'flex', gap: 6 }}>
                <IconButton
                  onClick={unifiedUndo}
                  disabled={!(editorHistory.canUndo || opCanUndo)}
                >
                  <Undo2 size={18} color="#FFFFFF" />
                </IconButton>
                <IconButton
                  onClick={unifiedRedo}
                  disabled={!(editorHistory.canRedo || opCanRedo)}
                >
                  <Redo2 size={18} color="#FFFFFF" />
                </IconButton>
              </div>
            </div>

            {/* Preview row: [wheel 1] … [wheel N] [+ icon] — + always rightmost,
                so adding a new wheel extends the chain linearly. */}
            <div
              ref={previewRowRef}
              className="no-scrollbar"
              onMouseDown={handleRowMouseDown}
              onWheel={handleRowWheel}
              style={{ display: 'flex', gap: 10, minWidth: 0, overflowX: 'auto', cursor: 'grab' }}
            >
              {flowSteps && flowSteps.length > 0 ? (
                flowSteps.map((step, idx) => {
                  const isActive = step.id === block.id;
                  const items = step.wheelConfig?.items ?? [];
                  const previewItems = isActive ? activeConfig.items : items;
                  const wheelLabel = (isActive ? activeConfig.name : step.wheelConfig?.name) || step.name;
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
                    : (isActive ? undefined : () => {
                        flushAutoSave();
                        // replace: true so switching previews doesn't push a
                        // new history entry (otherwise X/back would just
                        // unwind through each tile switch).
                        navigate(`/block/${step.id}`, {
                          replace: true,
                          state: { block: step, editMode: true, flowExperience, flowSteps },
                        });
                      });
                  return (
                    <TileWithLabel
                      key={step.id}
                      label={wheelLabel}
                      editable={!isTouchPrimary}
                      onLabelEdit={onRenameWheel}
                      onLabelCommit={onRenameCommit}
                      onLabelFocus={onLabelFocus}
                    >
                      <PreviewTile
                        index={idx}
                        active={isActive}
                        grabbed={grabbedIndex === idx}
                        innerRef={el => { tileElsRef.current[idx] = el; }}
                        onClick={isActive ? () => {
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
                          flushAutoSave();
                          // replace: true so switching previews doesn't push
                          // a new history entry — X/back should exit the
                          // editor, not unwind through each tile switch.
                          navigate(`/block/${step.id}`, {
                            replace: true,
                            state: {
                              block: step,
                              editMode: true,
                              flowExperience,
                              flowSteps,
                            },
                          });
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
                    onClick={() => setCtxMenuIndex(0)}
                    onContextOpen={() => setCtxMenuIndex(0)}
                  >
                    <WheelThumbnail items={activeConfig.items} size={72} />
                  </PreviewTile>
                </TileWithLabel>
              )}
              <TileWithLabel label="">
              <PreviewTile
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
                }}
              >
                <Plus size={32} color="rgba(255,255,255,0.85)" />
              </PreviewTile>
              </TileWithLabel>
            </div>

            {/* Chips row: bottom */}
            <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingTop: 2 }}>
              <Chip
                icon={<LayoutList size={14} />}
                label="Segments"
                onTap={() => { setEditorTab(0); setShowEditor(true); }}
              />
              <Chip
                icon={<Paintbrush size={14} />}
                label="Style"
                onTap={() => { setEditorTab(1); setShowEditor(true); }}
              />
              <Chip
                icon={<SettingsIcon size={14} />}
                label="Settings"
                onTap={() => setShowGearMenu(true)}
              />
              <Chip
                icon={<LayoutGrid size={14} />}
                label="Templates"
                onTap={() => { /* TODO */ }}
                muted
              />
            </div>
          </div>
        </div>

        {/* Mobile editor snapping sheet — opens when user taps a chip */}
        {isMobile && (
          <SnappingSheet
            visible={showEditor}
            snapPositions={[0, 460, screenHeight - 80]}
            initialSnap={1}
            bottomOffset={0}
            onCollapsed={() => { setShowEditor(false); setSheetHeight(0); }}
            onHeightChange={setSheetHeight}
          >
            <WheelEditor
              key={baseConfig.id}
              initialConfig={baseConfig}
              history={wrappedEditorHistory}
              onPreview={handleWheelPreview}
              selectedTab={editorTab}
              onTabChange={setEditorTab}
              onClose={() => { setShowEditor(false); setSheetHeight(0); }}
            />
          </SnappingSheet>
        )}

      </div>

      {/* Gear menu */}
      {showGearMenu && (
        <DraggableSheet maxWidth={9999} onClose={() => setShowGearMenu(false)}>
          <div style={{ padding: '0 24px 32px' }}>
            <h3 style={{ fontSize: 20, fontWeight: 800, textAlign: 'center', margin: '0 0 24px' }}>Spin Settings</h3>

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
          </div>
        </DraggableSheet>
      )}

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
                setEditorTab(0);
                setShowEditor(true);
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
function TileWithLabel({ label, editable, onLabelEdit, onLabelCommit, onLabelFocus, children }: {
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
    color: 'rgba(255,255,255,0.85)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    textAlign: 'center',
    lineHeight: '18px',
  };
  const isEditable = editable && !!onLabelEdit;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, flexShrink: 0 }}>
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
        backgroundColor: '#F4F4F5',
        border: '1.5px solid #E4E4E7',
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
        backgroundColor: value ? withAlpha(PRIMARY, 0.12) : '#F4F4F5',
        border: `1.5px solid ${value ? PRIMARY : '#D4D4D8'}`,
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
        backgroundColor: value ? PRIMARY : '#D4D4D8',
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
  index, active, grabbed, innerRef, shouldSuppressClick, children,
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
  // Callback ref so parent can collect a { index -> element } map for
  // midpoint hit-testing during reorder.
  innerRef?: (el: HTMLDivElement | null) => void;
  // Returns true if the click should be ignored — used to skip tile navigate
  // immediately after a row drag-to-scroll mouse gesture.
  shouldSuppressClick?: () => boolean;
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
        height: 88,
        borderRadius: 16,
        backgroundColor: active ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.12)',
        border: `2px solid ${active ? '#FFFFFF' : 'rgba(255,255,255,0.2)'}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        cursor: onClick ? 'pointer' : 'default',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        // Suppress the iOS long-press callout (copy/save/select) that
        // otherwise fires on top of our own long-press gesture.
        WebkitTouchCallout: 'none',
        // While grabbed (long-press active), kill native touch pan so the
        // row doesn't scroll under the user's finger during reorder/menu-hold.
        touchAction: effectiveGrabbed ? 'none' : 'manipulation',
        transform: effectiveGrabbed ? 'scale(1.08)' : 'scale(1)',
        boxShadow: effectiveGrabbed ? '0 6px 16px rgba(0,0,0,0.35)' : 'none',
        transition: 'transform 0.12s ease, box-shadow 0.12s ease',
        zIndex: effectiveGrabbed ? 2 : undefined,
      }}
    >
      {children}
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
