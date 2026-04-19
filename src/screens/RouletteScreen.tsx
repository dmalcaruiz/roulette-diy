import { useState, useRef, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Block, WheelConfig } from '../models/types';
import SpinningWheel, { SpinningWheelHandle } from '../components/SpinningWheel';
import WheelEditor, { buildInitialState, EditorState, stateToConfig } from '../components/WheelEditor';
import { PushDownButton } from '../components/PushDownButton';
import { withAlpha } from '../utils/colorUtils';
import { ON_SURFACE, PRIMARY } from '../utils/constants';
import { ArrowLeft, Shuffle, Sparkles, Play, X, Undo2, Redo2, Check, Plus, LayoutList, Paintbrush, Settings as SettingsIcon, LayoutGrid, Type, Trash2, Copy, ArrowLeftFromLine, ArrowRightFromLine } from 'lucide-react';
import DraggableSheet from '../components/DraggableSheet';
import SnappingSheet from '../components/SnappingSheet';
import { useHistory } from '../hooks/useHistory';
import WheelThumbnail from '../components/WheelThumbnail';
import { useAuth } from '../contexts/AuthContext';
import {
  buildAppendWheelChange, buildInsertWheelChange, buildDuplicateWheelChange,
  buildRemoveWheelChange, persistBlocks, persistFlowChange,
} from '../services/flowService';
import { deleteDraft, saveDraft, type CloudBlock } from '../services/blockService';
import { dbg, sid, sids } from '../utils/debugLog';

interface RouletteScreenProps {
  block: Block;
  editMode?: boolean;
  onBlockUpdated?: (block: Block) => void;
  // When true, this screen is rendered as an overlay inside BlockScreen.
  // The top bar's Check icon calls onDismiss instead of navigating back,
  // and the publish sheet is moved out (handled by BlockScreen).
  overlay?: boolean;
  onDismiss?: () => void;
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
  block, editMode = false, onBlockUpdated, overlay = false, onDismiss,
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
    const startFlowSteps = flowStepsRef.current;
    const startFlowExp = flowExperienceRef.current;
    if (!startFlowSteps || !startFlowExp) {
      // Standalone (no flow) — long-press still selects; no reorder possible.
      // Release behavior falls back to context menu via onContextOpen.
      return;
    }

    const prevExp = startFlowExp;
    const prevSteps = startFlowSteps;
    let currentSource = sourceIndex;
    let didMove = false;
    let menuOpened = false;
    setGrabbedIndex(sourceIndex);
    dbg('RouletteScreen', 'reorder:start', { index: sourceIndex });

    // Auto-open the context menu if the user keeps holding without dragging.
    // Fires 550ms after activation (~850ms total from initial press).
    const autoMenuTimer = setTimeout(() => {
      if (didMove || menuOpened) return;
      menuOpened = true;
      cleanup();
      setGrabbedIndex(null);
      setCtxMenuIndex(currentSource);
    }, 550);

    const onMove = (me: PointerEvent) => {
      if (menuOpened) return;
      // Cancel the auto-menu once the user meaningfully moves.
      const dx = me.clientX - startX;
      const dy = me.clientY - startY;
      if (Math.hypot(dx, dy) > 8) clearTimeout(autoMenuTimer);

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
      clearTimeout(autoMenuTimer);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };

    const onUp = () => {
      if (menuOpened) {
        cleanup();
        return;
      }
      cleanup();
      setGrabbedIndex(null);
      if (didMove) {
        const toSave = flowExperienceRef.current;
        if (user && toSave) {
          dbg('RouletteScreen', 'reorder:end:persist', { expId: sid(toSave.id) });
          saveDraft(user.uid, toSave).catch(err => {
            dbg('RouletteScreen', 'reorder:persist-fail', { err: String(err) });
            onFlowChange?.(prevExp, prevSteps);
            alert('Failed to save new order.');
          });
        }
      } else {
        setCtxMenuIndex(currentSource);
      }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, [user, onFlowChange]);

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
          const prevExp = exp, prevSteps = steps;
          onFlowChange?.(change.experience ?? undefined, change.nextSteps);
          const deletedActive = steps[index].id === block.id;
          if (deletedActive) {
            if (change.nextSteps.length > 0) {
              const nextIdx = Math.min(index, change.nextSteps.length - 1);
              navigate(`/block/${change.nextSteps[nextIdx].id}`, {
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
          persistFlowChange(user.uid, change).catch(err => {
            dbg('RouletteScreen', 'ctx:delete:persist-fail', { err: String(err) });
            onFlowChange?.(prevExp, prevSteps);
            alert('Failed to delete wheel.');
          });
          return;
        }
        if (action === 'duplicate') {
          const change = buildDuplicateWheelChange({ experience: exp, steps, index });
          const prevExp = exp, prevSteps = steps;
          onFlowChange?.(change.experience ?? undefined, change.nextSteps);
          persistFlowChange(user.uid, change).catch(err => {
            dbg('RouletteScreen', 'ctx:duplicate:persist-fail', { err: String(err) });
            onFlowChange?.(prevExp, prevSteps);
            alert('Failed to duplicate wheel.');
          });
          return;
        }
        if (action === 'insertBefore' || action === 'insertAfter') {
          const targetIndex = action === 'insertBefore' ? index : index + 1;
          const change = buildInsertWheelChange({
            currentBlock, experience: exp, steps, index: targetIndex,
          });
          const prevExp = exp, prevSteps = steps;
          onFlowChange?.(change.experience ?? undefined, change.nextSteps);
          persistFlowChange(user.uid, change).catch(err => {
            dbg('RouletteScreen', 'ctx:insert:persist-fail', { err: String(err) });
            onFlowChange?.(prevExp, prevSteps);
            alert('Failed to insert wheel.');
          });
          return;
        }
      } else {
        // Standalone wheel — no flow context.
        if (action === 'delete') {
          await deleteDraft(user.uid, block.id);
          navigate('/');
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
          onFlowChange?.(change.experience ?? undefined, change.nextSteps);
          const stampedCurrent = change.writes.find(w => w.id === block.id);
          if (stampedCurrent) onBlockUpdated?.(stampedCurrent);
          persistFlowChange(user.uid, change).catch(err => {
            dbg('RouletteScreen', 'ctx:insert-wrap:persist-fail', { err: String(err) });
            onFlowChange?.(undefined, []);
            alert('Failed to insert wheel.');
          });
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
              history={editorHistory}
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
              if (overlay && onDismiss) onDismiss();
              else navigate('/');
            }}
            style={{ padding: 8 }}
          >
            <ArrowLeft size={32} color="#FFFFFF" />
          </button>
          <input
            type="text"
            value={editorHistory.state.name}
            onChange={e => editorHistory.patch({ name: e.target.value })}
            onBlur={editorHistory.commit}
            placeholder="Wheel name"
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
          <div style={{ display: 'flex', gap: 4 }}>
            {isPlayMode && (
              <button onClick={() => setIsPlayMode(false)} style={{ padding: 8 }}>
                <X size={32} color="#FFFFFF" />
              </button>
            )}
            {!isPlayMode && overlay && (
              <button
                onClick={() => { flushAutoSave(); onDismiss?.(); }}
                style={{
                  padding: 8,
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                }}
                aria-label="Done editing"
              >
                <Check size={32} color="#FFFFFF" strokeWidth={3} />
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
                <IconButton onClick={editorHistory.undo} disabled={!editorHistory.canUndo}>
                  <Undo2 size={18} color="#FFFFFF" />
                </IconButton>
                <IconButton onClick={editorHistory.redo} disabled={!editorHistory.canRedo}>
                  <Redo2 size={18} color="#FFFFFF" />
                </IconButton>
              </div>
            </div>

            {/* Preview row: [wheel 1] … [wheel N] [+ icon] — + always rightmost,
                so adding a new wheel extends the chain linearly. */}
            <div ref={previewRowRef} style={{ display: 'flex', gap: 10, minWidth: 0, overflowX: 'auto' }}>
              {flowSteps && flowSteps.length > 0 ? (
                flowSteps.map((step, idx) => {
                  const isActive = step.id === block.id;
                  const items = step.wheelConfig?.items ?? [];
                  const previewItems = isActive ? activeConfig.items : items;
                  return (
                    <PreviewTile
                      key={step.id}
                      index={idx}
                      active={isActive}
                      grabbed={grabbedIndex === idx}
                      innerRef={el => { tileElsRef.current[idx] = el; }}
                      onClick={isActive ? undefined : () => {
                        dbg('RouletteScreen', 'tile:tap', {
                          from: sid(block.id),
                          to: sid(step.id),
                          flowExp: sid(flowExperience?.id ?? null),
                          flowSteps: sids(flowSteps),
                        });
                        flushAutoSave();
                        navigate(`/block/${step.id}`, {
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
                    >
                      <WheelThumbnail items={previewItems} size={72} />
                    </PreviewTile>
                  );
                })
              ) : (
                <PreviewTile active onContextOpen={() => setCtxMenuIndex(0)}>
                  <WheelThumbnail items={activeConfig.items} size={72} />
                </PreviewTile>
              )}
              <PreviewTile
                onClick={() => {
                  if (!user) { dbg('RouletteScreen', 'plus:no-user'); return; }
                  const t0 = performance.now();
                  dbg('RouletteScreen', 'plus:0-click', {
                    currentBlock: sid(block.id),
                    parent: sid((block as CloudBlock).parentExperienceId ?? null),
                    flowExp: sid(flowExperience?.id ?? null),
                    flowSteps: sids(flowSteps),
                    flowStepsLen: flowSteps?.length ?? 0,
                  });
                  dbg('RouletteScreen', 'plus:1-flushAutoSave');
                  flushAutoSave();

                  let change;
                  try {
                    dbg('RouletteScreen', 'plus:2-buildChange');
                    change = buildAppendWheelChange({
                      currentBlock: { ...block, wheelConfig: activeConfig } as CloudBlock,
                      experience: flowExperience,
                    });
                  } catch (e) {
                    dbg('RouletteScreen', 'plus:build-fail', { err: e instanceof Error ? e.message : String(e) });
                    alert(e instanceof Error ? e.message : 'Failed to add wheel.');
                    return;
                  }

                  const prevFlowSteps = flowSteps;
                  const prevFlowExperience = flowExperience;
                  const nextFlowSteps: CloudBlock[] = flowSteps && flowSteps.length > 0
                    ? [...flowSteps, change.newBlock]
                    : [
                        { ...(block as CloudBlock), wheelConfig: activeConfig, parentExperienceId: change.experience.id },
                        change.newBlock,
                      ];
                  dbg('RouletteScreen', 'plus:3-computed-nextSteps', {
                    mode: flowSteps && flowSteps.length > 0 ? 'append-existing' : 'wrap-new',
                    prevLen: prevFlowSteps?.length ?? 0,
                    nextLen: nextFlowSteps.length,
                    ids: sids(nextFlowSteps),
                  });

                  dbg('RouletteScreen', 'plus:4-onFlowChange-call');
                  onFlowChange?.(change.experience, nextFlowSteps);

                  const stampedCurrent = change.writes.find(w => w.id === block.id);
                  if (stampedCurrent) {
                    dbg('RouletteScreen', 'plus:5-onBlockUpdated-stampedCurrent', {
                      block: sid(stampedCurrent.id),
                      parent: sid(stampedCurrent.parentExperienceId ?? null),
                    });
                    onBlockUpdated?.(stampedCurrent);
                  } else {
                    dbg('RouletteScreen', 'plus:5-no-stampedCurrent');
                  }

                  dbg('RouletteScreen', 'plus:6-persist-start', {
                    writes: sids(change.writes),
                    tookMs: Math.round(performance.now() - t0),
                  });
                  persistBlocks(user.uid, change.writes)
                    .then(() => dbg('RouletteScreen', 'plus:7-persist-ok', { tookMs: Math.round(performance.now() - t0) }))
                    .catch((err) => {
                      dbg('RouletteScreen', 'plus:7-persist-fail-rollback', { err: err instanceof Error ? err.message : String(err) });
                      alert(`Failed to save new wheel: ${err instanceof Error ? err.message : String(err)}`);
                      onFlowChange?.(prevFlowExperience, prevFlowSteps ?? []);
                    });
                }}
              >
                <Plus size={32} color="rgba(255,255,255,0.85)" />
              </PreviewTile>
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
              history={editorHistory}
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
        <DraggableSheet onClose={() => setShowGearMenu(false)}>
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
        <DraggableSheet onClose={() => setCtxMenuIndex(null)}>
          <div style={{ padding: '0 20px 28px' }}>
            <h3 style={{ fontSize: 18, fontWeight: 800, textAlign: 'center', margin: '0 0 16px' }}>
              Wheel actions
            </h3>
            <CtxRow
              icon={<ArrowLeftFromLine size={20} />}
              label="Insert wheel before"
              onTap={() => { const i = ctxMenuIndex; setCtxMenuIndex(null); runCtxAction('insertBefore', i); }}
            />
            <CtxRow
              icon={<ArrowRightFromLine size={20} />}
              label="Insert wheel after"
              onTap={() => { const i = ctxMenuIndex; setCtxMenuIndex(null); runCtxAction('insertAfter', i); }}
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
              onTap={() => {
                const i = ctxMenuIndex;
                setCtxMenuIndex(null);
                if (!confirm('Delete this wheel?')) return;
                runCtxAction('delete', i);
              }}
            />
          </div>
        </DraggableSheet>
      )}

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
  index, active, grabbed, innerRef, children,
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
  children: React.ReactNode;
}) {
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Standalone-only: second timer that auto-opens the context menu if the user
  // keeps holding after activation without dragging.
  const menuAutoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didLongPressRef = useRef(false);
  const startPosRef = useRef<{ x: number; y: number } | null>(null);
  // Standalone fallback: when there is no reorder handler (no flow), a
  // long-press still needs to open the context menu on release.
  const primedForContextRef = useRef(false);

  const clearLongPress = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    if (menuAutoTimerRef.current) {
      clearTimeout(menuAutoTimerRef.current);
      menuAutoTimerRef.current = null;
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
          onClick?.();
          if (index !== undefined && onGrabStart) {
            // Parent takes over via window listeners; release handling lives
            // in parent's onUp (reorder commit vs. context-menu open).
            const start = startPosRef.current;
            onGrabStart(index, start?.x ?? 0, start?.y ?? 0);
          } else if (onContextOpen) {
            // Standalone — no reorder. Arm release-opens-menu, and also
            // auto-open the menu after another 550ms of holding still.
            primedForContextRef.current = true;
            menuAutoTimerRef.current = setTimeout(() => {
              menuAutoTimerRef.current = null;
              primedForContextRef.current = false;
              onContextOpen();
            }, 550);
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
        if (primedForContextRef.current) {
          primedForContextRef.current = false;
          onContextOpen?.();
        }
      }) : undefined}
      onPointerCancel={(onGrabStart || onContextOpen) ? (() => {
        clearLongPress();
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
        touchAction: 'manipulation',
        transform: grabbed ? 'scale(1.08)' : 'scale(1)',
        boxShadow: grabbed ? '0 6px 16px rgba(0,0,0,0.35)' : 'none',
        transition: 'transform 0.12s ease, box-shadow 0.12s ease',
        zIndex: grabbed ? 2 : undefined,
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
