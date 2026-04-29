import { useState, useRef, useCallback } from 'react';
import type { CloudBlock } from '../services/blockService';
import { BlockType, getBlockTypeLabel, getBlockItemCountLabel } from '../models/types';
import WheelThumbnail from './WheelThumbnail';
import SwipeableActionCell from './SwipeableActionCell';
import { oklchShadow, withAlpha } from '../utils/colorUtils';
import { ON_SURFACE, PRIMARY, BORDER } from '../utils/constants';
import {
  GripVertical, ChevronRight, LayoutGrid, Copy, Trash2,
  Disc3, LayoutList, Compass, Heart, MessageCircle, Trophy,
} from 'lucide-react';
import { usePublishedStats, type BlockStats } from '../hooks/usePublishedStats';

const ROULETTE_COLOR = '#38BDF8';
const LIST_COLOR = '#88d515';
const EXPERIENCE_COLOR = '#c827d4';

// Vertical gap between consecutive rows. Lives on the row wrapper as
// marginBottom; the slot-shift math below assumes this exact value so the
// neighbor offsets land in the gap naturally.
const ROW_GAP = 10;

function colorForType(type: BlockType): string {
  switch (type) {
    case 'roulette': return ROULETTE_COLOR;
    case 'listRandomizer': return LIST_COLOR;
    case 'experience': return EXPERIENCE_COLOR;
  }
}

function iconForType(type: BlockType) {
  switch (type) {
    case 'roulette': return Disc3;
    case 'listRandomizer': return LayoutList;
    case 'experience': return Compass;
  }
}

type BlockFilter = 'all' | 'roulettes' | 'lists' | 'experiences';

interface BlocksListProps {
  blocks: CloudBlock[];
  onBlockTap: (block: CloudBlock) => void;
  onBlockEdit: (block: CloudBlock) => void;
  onBlockDuplicate: (block: CloudBlock) => void;
  onBlockDelete: (id: string) => void;
  // Fires after a drag-reorder commit lands. Receives the new order of ids
  // for the *currently filtered* row set. Parent decides how to merge that
  // back into its master block list.
  onReorder?: (orderedIds: string[]) => void;
  showFilters?: boolean;    // hide filter chips when embedded in smaller contexts
  // Display-only: show every block as a "Flow" (no type split). A standalone
  // roulette/list is shown as a 1-step flow. Callers should pre-filter out
  // child wheels (those with parentExperienceId set) when using this.
  asFlows?: boolean;
  // Unfiltered block set used to resolve Experience step blockIds to their
  // child wheels (for rendering thumbnails). Only needed when asFlows is on
  // and the flow contains Experience blocks whose children are not in `blocks`.
  allBlocks?: CloudBlock[];
}

export default function BlocksList({
  blocks, onBlockTap, onBlockEdit, onBlockDuplicate, onBlockDelete,
  onReorder, showFilters = true, asFlows = false, allBlocks,
}: BlocksListProps) {
  const [filter, setFilter] = useState<BlockFilter>('all');
  const stats = usePublishedStats(blocks);

  const filtered = blocks.filter(b => {
    if (filter === 'all') return true;
    if (filter === 'roulettes') return b.type === 'roulette';
    if (filter === 'lists') return b.type === 'listRandomizer';
    return b.type === 'experience';
  });

  // ── Reorder (long-press grip handle + drag vertically on a card) ───────
  // Ported from RouletteScreen's preview-row pattern, oriented vertically:
  //  - Per-row refs (rowElsRef) so we can snapshot positions at grab-start.
  //  - Window-level pointermove/pointerup driven from the grip's pointerdown
  //    (GripVertical owns its own pointerdown + stopPropagation, so the
  //    outer SwipeableActionCell never claims the gesture).
  //  - Two-phase release: phase 1 glides the grabbed row to its drop slot
  //    via translateY (same easing as neighbors); phase 2 commits the array
  //    reorder atomically via onReorder, with `isCommitting` suppressing
  //    transform transitions for one paint frame so the natural-position
  //    shift doesn't re-animate on top of the now-zero translateY.
  const rowElsRef = useRef<(HTMLDivElement | null)[]>([]);
  const filteredRef = useRef<CloudBlock[]>(filtered);
  filteredRef.current = filtered;

  const [grabbedIndex, setGrabbedIndex] = useState<number | null>(null);
  // Live pointer-follow offset for the grabbed row. Plain (pointerY - startY)
  // — no slot-swap compensation needed because the array isn't reordered
  // during the drag; the row stays in its original DOM slot the whole time.
  const [dragOffsetY, setDragOffsetY] = useState(0);
  // Where the grabbed row WILL drop on release. While dragging, the
  // neighbors between source and dropTarget shift up/down by one slot
  // (sourceSlotHeight) to open an empty drop spot at the eventual landing.
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);
  // Phase-1 settling: after release, the grabbed row animates from the
  // pointer to the drop slot via translateY (with the same 0.22s easing as
  // a neighbor slot-shift). While true, transition timing for the grabbed
  // row flips from 0s (instant pointer-follow) to 0.22s (settle glide).
  const [isSettling, setIsSettling] = useState(false);
  // Phase-2 commit window: true for exactly one paint frame while the
  // array reorder lands. During that frame every row's `transform` value
  // changes (from finalOffset / slotOffset back to 0) at the same moment
  // its natural DOM position shifts. We must NOT animate that transform
  // change — the natural shift already moves the row to its resting spot,
  // and animating the transform on top would re-translate past it and bounce.
  const [isCommitting, setIsCommitting] = useState(false);
  // Pending phase-2 commit timer. Cleared if a new grab starts before the
  // settle finishes — prevents the in-flight commit from clobbering fresh
  // drag state with the previous drop's reorder.
  const settleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Snapshot of row metrics at grab-start, used for hit-testing the drop
  // target and computing the dragged row's final translateY in phase 1.
  // Captured fresh per gesture so layout shifts between gestures don't
  // poison the math.
  const dragSnapshotRef = useRef<{
    rowTops: number[];
    rowHeights: number[];
    sourceSlotHeight: number; // sourceRow box height + ROW_GAP
  } | null>(null);

  // Slot-shift offset for a non-grabbed row at index `i` while the user
  // is dragging the row at `sourceIndex` toward `dropTargetIndex`. Rows
  // between source and target shift one slot toward source, opening an
  // empty slot at target where the grabbed row will land on release.
  const computeSlotOffset = (i: number): number => {
    if (grabbedIndex === null || dropTargetIndex === null) return 0;
    if (i === grabbedIndex) return 0; // grabbed row owns its own transform
    const slot = dragSnapshotRef.current?.sourceSlotHeight ?? 0;
    if (dropTargetIndex > grabbedIndex) {
      // Dragging down — rows in (source, target] shift up.
      if (i > grabbedIndex && i <= dropTargetIndex) return -slot;
    } else if (dropTargetIndex < grabbedIndex) {
      // Dragging up — rows in [target, source) shift down.
      if (i >= dropTargetIndex && i < grabbedIndex) return slot;
    }
    return 0;
  };

  const handleGrabStart = useCallback((sourceIndex: number, startX: number, startY: number) => {
    // Cancel any pending phase-2 settle from the previous drop — its
    // finishRelease would otherwise fire mid-grab and stomp this state.
    if (settleTimeoutRef.current) {
      clearTimeout(settleTimeoutRef.current);
      settleTimeoutRef.current = null;
    }

    // Snapshot every row's top + height once at activation. Using snapshot
    // positions for hit-test (rather than live rects) means the slot-shifts
    // we apply to neighbors don't poison the test.
    const rowTops: number[] = [];
    const rowHeights: number[] = [];
    rowElsRef.current.forEach(el => {
      if (el) {
        const r = el.getBoundingClientRect();
        rowTops.push(r.top);
        rowHeights.push(r.height);
      } else {
        rowTops.push(0);
        rowHeights.push(0);
      }
    });
    const sourceSlotHeight = (rowHeights[sourceIndex] ?? 0) + ROW_GAP;
    dragSnapshotRef.current = { rowTops, rowHeights, sourceSlotHeight };

    // Activate the grabbed visual immediately on long-press fire — the
    // scale-up + box-shadow lights up while the user's finger is still
    // stationary, signalling the gesture is live before any motion.
    let currentTarget = sourceIndex;
    let dragged = false; // true once the pointer crosses 10px from grab-start
    setGrabbedIndex(sourceIndex);
    setDragOffsetY(0);
    setDropTargetIndex(sourceIndex);

    const onMove = (me: PointerEvent) => {
      const dx = me.clientX - startX;
      const dy = me.clientY - startY;

      // Live pointer-follow — grabbed row sits in its original DOM slot
      // and is offset by (pointerY - startY). No slot-swap compensation.
      setDragOffsetY(dy);

      // Require a meaningful movement from the grab-start position before
      // we shift neighbors. Avoids twitchy slot indicators on sub-pixel
      // jitter at the start of a press. The first time we cross the
      // threshold we mark this gesture as a drag.
      if (Math.hypot(dx, dy) < 10) return;
      dragged = true;

      // Hit-test against snapshot row midpoints. With variable-height cards,
      // a fixed-slot Math.round approach mistargets; iterating midpoints
      // handles any height profile correctly.
      const snap = dragSnapshotRef.current!;
      let target = snap.rowTops.length - 1;
      for (let i = 0; i < snap.rowTops.length; i++) {
        const mid = snap.rowTops[i] + snap.rowHeights[i] / 2;
        if (me.clientY < mid) {
          target = i;
          break;
        }
      }
      target = Math.max(0, Math.min(target, filteredRef.current.length - 1));
      if (target === currentTarget) return;
      currentTarget = target;
      setDropTargetIndex(target);
    };

    const cleanup = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };

    // Two-phase release (variable-height vertical variant of the preview
    // row's pattern). Phase 1 animates the grabbed row to its drop slot via
    // translateY. Phase 2, after the animation finishes, commits the array
    // reorder atomically — at that moment every row's new natural position
    // already equals where it is currently rendered, so there's no jump.
    const finishRelease = (commit: boolean) => {
      if (commit && currentTarget !== sourceIndex) {
        const next = [...filteredRef.current];
        const [moved] = next.splice(sourceIndex, 1);
        next.splice(currentTarget, 0, moved);
        onReorder?.(next.map(b => b.id));
      }
      setGrabbedIndex(null);
      setDragOffsetY(0);
      setDropTargetIndex(null);
      setIsSettling(false);
      dragSnapshotRef.current = null;
    };

    const onUp = () => {
      cleanup();

      if (currentTarget !== sourceIndex) {
        // Phase 1: glide the grabbed row from its current pointer offset
        // to the drop slot's offset. Final translateY is the delta from
        // the row's CURRENT DOM top (= source top) to its NEW natural top
        // post-commit. With variable heights this depends on direction:
        //   target > source: new top = rowTops[target] + rowHeights[target]
        //                              - rowHeights[source]
        //   target < source: new top = rowTops[target]
        const snap = dragSnapshotRef.current!;
        const sourceTop = snap.rowTops[sourceIndex];
        const finalOffset = currentTarget > sourceIndex
          ? snap.rowTops[currentTarget] + snap.rowHeights[currentTarget] - snap.rowHeights[sourceIndex] - sourceTop
          : snap.rowTops[currentTarget] - sourceTop;
        setIsSettling(true);
        setDragOffsetY(finalOffset);
        settleTimeoutRef.current = setTimeout(() => {
          settleTimeoutRef.current = null;
          // Suppress transform transitions for the commit frame, then
          // re-enable on next rAF so subsequent ops animate normally.
          setIsCommitting(true);
          finishRelease(true);
          requestAnimationFrame(() => setIsCommitting(false));
        }, 220);
      } else {
        finishRelease(false);
      }
    };

    const onCancel = () => {
      cleanup();
      // Keep `dragged` referenced so the var isn't flagged unused; release
      // logic itself only cares about whether the drop target moved.
      void dragged;
      if (currentTarget !== sourceIndex) {
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
      } else {
        finishRelease(false);
      }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  }, [onReorder]);

  return (
    <div>
      {showFilters && !asFlows && (
        <div style={{ display: 'flex', gap: 8, padding: '0 4px 14px', flexWrap: 'wrap' }}>
          {([
            ['all', 'All'],
            ['roulettes', 'Roulettes'],
            ['lists', 'Lists'],
            ['experiences', 'Experiences'],
          ] as [BlockFilter, string][]).map(([value, label]) => {
            const isActive = filter === value;
            return (
              <div
                key={value}
                onClick={() => setFilter(value)}
                style={{
                  padding: '6px 14px',
                  borderRadius: 20,
                  backgroundColor: isActive ? PRIMARY : 'transparent',
                  border: `1.5px solid ${isActive ? PRIMARY : BORDER}`,
                  fontSize: 12, fontWeight: 700,
                  color: isActive ? '#FFFFFF' : withAlpha(ON_SURFACE, 0.6),
                  cursor: 'pointer',
                }}
              >
                {label}
              </div>
            );
          })}
        </div>
      )}

      {filtered.length === 0 ? (
        <EmptyState filter={filter} />
      ) : (
        filtered.map((block, idx) => {
          const isGrabbed = grabbedIndex === idx;
          const slotOffset = isGrabbed ? dragOffsetY : computeSlotOffset(idx);
          // Transition rules mirror PreviewTile: keep `transform` in the
          // transition list always — only the duration toggles. While
          // grabbed (mid-drag) the transform must follow the pointer with
          // no easing; while settling it glides at 0.22s; on the commit
          // frame it must be instant so the natural-position shift doesn't
          // re-animate on top of a now-zero translateY.
          const grabbedNotSettling = isGrabbed && !isSettling;
          const transition = (grabbedNotSettling || isCommitting)
            ? 'transform 0s, box-shadow 0.12s ease'
            : 'transform 0.22s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.12s ease';
          // Order matters: translate first, then scale — so the absolute
          // pixel offset isn't multiplied by the scale factor and the row
          // tracks the pointer 1:1 regardless of zoom.
          const transform = isGrabbed
            ? `translateY(${slotOffset}px) scale(1.04)`
            : `translateY(${slotOffset}px) scale(1)`;
          return (
            <BlockRow
              key={block.id}
              innerRef={el => { rowElsRef.current[idx] = el; }}
              index={idx}
              isGrabbed={isGrabbed}
              transform={transform}
              transition={transition}
              onGrabStart={onReorder ? handleGrabStart : undefined}
            >
              <SwipeableActionCell
                bottomPeek={6.5}
                disabled={isGrabbed}
                trailingActions={[
                  { color: ROULETTE_COLOR, icon: <Copy size={26} />, onTap: () => onBlockDuplicate(block) },
                  { color: '#EF4444', icon: <Trash2 size={26} />, onTap: () => onBlockDelete(block.id), expandOnFullSwipe: true },
                ]}
              >
                <BlockCard
                  block={block}
                  stats={block.publishedWheelId ? stats.get(block.publishedWheelId) : undefined}
                  onTap={() => onBlockTap(block)}
                  onEdit={() => onBlockEdit(block)}
                  asFlow={asFlows}
                  allBlocks={allBlocks ?? blocks}
                />
              </SwipeableActionCell>
            </BlockRow>
          );
        })
      )}
    </div>
  );
}

// Row wrapper that owns the long-press → reorder activation. Ported from
// PreviewTile in RouletteScreen:
//  - 300ms long-press threshold.
//  - 8px movement during the press cancels the timer (so a vertical scroll
//    or a horizontal swipe-to-reveal-actions still works normally).
//  - On fire, releases any pointer capture the inner SwipeableActionCell
//    set so it can't subsequently claim a horizontal motion as a swipe.
//  - Suppresses the click that follows a successful long-press, so the
//    card doesn't navigate-to-block on release.
//  - Suppresses the iOS long-press callout (copy/save) and disables native
//    touch pan during the grab.
function BlockRow({
  index, isGrabbed, transform, transition, onGrabStart, innerRef, children,
}: {
  index: number;
  isGrabbed: boolean;
  transform: string;
  transition: string;
  onGrabStart?: (index: number, startX: number, startY: number) => void;
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
        // Suppress the click that fires on pointerup after a successful
        // long-press, so the card doesn't navigate-to-block on release.
        if (didLongPressRef.current) {
          e.stopPropagation();
          e.preventDefault();
          didLongPressRef.current = false;
        }
      }}
      onPointerDown={onGrabStart ? (e => {
        if (e.button === 2) return;
        didLongPressRef.current = false;
        startPosRef.current = { x: e.clientX, y: e.clientY };
        capturedRef.current = { target: e.target as Element, pointerId: e.pointerId };
        const sx = e.clientX;
        const sy = e.clientY;
        longPressTimerRef.current = setTimeout(() => {
          longPressTimerRef.current = null;
          didLongPressRef.current = true;
          // Release the SwipeableActionCell's pointer capture so a
          // subsequent horizontal pointermove can't be claimed as a swipe
          // on top of our reorder transform.
          const cap = capturedRef.current;
          if (cap && cap.target.hasPointerCapture?.(cap.pointerId)) {
            cap.target.releasePointerCapture(cap.pointerId);
          }
          onGrabStart(index, sx, sy);
        }, 300);
      }) : undefined}
      onPointerMove={onGrabStart ? (e => {
        const start = startPosRef.current;
        if (!start) return;
        const dx = e.clientX - start.x;
        const dy = e.clientY - start.y;
        if (Math.hypot(dx, dy) > 8) clearLongPress();
      }) : undefined}
      onPointerUp={onGrabStart ? (() => {
        clearLongPress();
        startPosRef.current = null;
      }) : undefined}
      onPointerCancel={onGrabStart ? (() => {
        clearLongPress();
        startPosRef.current = null;
      }) : undefined}
      style={{
        marginBottom: ROW_GAP,
        position: 'relative',
        zIndex: isGrabbed ? 5 : undefined,
        transform,
        transition,
        boxShadow: isGrabbed ? '0 12px 24px rgba(0,0,0,0.18)' : 'none',
        // Matches the halo's outer radius (bottom-face radius 21 + 3.5
        // halo spread = 24.5), so the drag-shadow rounds at the same
        // arc as the visible card's outer halo edge — no rounded-cutout
        // mismatch where the page background peeks through.
        borderRadius: 24.5,
        // While grabbed, kill native touch pan so the page doesn't scroll
        // under the user's finger during reorder.
        touchAction: isGrabbed ? 'none' : undefined,
        // Suppress the iOS long-press callout that otherwise fires on
        // top of our own long-press gesture.
        WebkitTouchCallout: 'none',
        userSelect: 'none',
        WebkitUserSelect: 'none',
      }}
    >
      {children}
    </div>
  );
}

function EmptyState({ filter }: { filter: BlockFilter }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      padding: '40px 20px', textAlign: 'center',
    }}>
      <div style={{
        width: 64, height: 64, borderRadius: 20,
        backgroundColor: withAlpha(PRIMARY, 0.1),
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        marginBottom: 14,
      }}>
        <LayoutGrid size={32} color={PRIMARY} />
      </div>
      <div style={{ fontSize: 15, fontWeight: 700, color: withAlpha(ON_SURFACE, 0.55) }}>
        {filter === 'all' ? 'No blocks yet' : `No ${filter} yet`}
      </div>
    </div>
  );
}

function BlockCard({ block, stats, onTap, onEdit, asFlow, allBlocks }: {
  block: CloudBlock;
  stats?: BlockStats;
  onTap: () => void;
  onEdit: () => void;
  asFlow?: boolean;
  allBlocks?: CloudBlock[];
}) {
  const bottomColor = oklchShadow('#FFFFFF');
  const typeColor = asFlow ? EXPERIENCE_COLOR : colorForType(block.type);
  const TypeIcon = asFlow ? Compass : iconForType(block.type);
  const isPublished = !!block.publishedWheelId;
  const isChallenge = stats?.isChallenge ?? false;
  // Step count for flow display: experiences use their steps array; standalone
  // roulettes/lists count as a 1-step flow.
  const stepCount = asFlow
    ? (block.type === 'experience' ? (block.experienceConfig?.steps.length ?? 0) : 1)
    : 0;
  // Flow preview thumbnails: resolve step blockIds via allBlocks. Standalone
  // roulettes preview their own wheel. Experiences preview their child
  // roulettes in order. Non-roulette children are skipped for now.
  const flowPreviewItems = (() => {
    if (!asFlow) return [];
    if (block.type === 'roulette' && block.wheelConfig) {
      return [block.wheelConfig.items];
    }
    if (block.type === 'experience' && allBlocks) {
      const stepIds = block.experienceConfig?.steps.map(s => s.blockId) ?? [];
      return stepIds
        .map(id => allBlocks.find(b => b.id === id))
        .filter((b): b is CloudBlock => !!b && b.type === 'roulette' && !!b.wheelConfig)
        .map(b => b.wheelConfig!.items);
    }
    return [];
  })();

  return (
    // Outer wrapper reserves room on every side where the bottom face's
    // 3.5px halo ring would otherwise extend past the SwipeableActionCell's
    // overflow:hidden clip box: 3.5px on left/right, and (peek 6.5 + halo
    // 3.5) = 10px on bottom. The top face uses a negative horizontal
    // margin to span back to the original card width — only the bottom
    // face is inset, so its halo fills the reserved padding cleanly.
    <div onClick={onTap} style={{ cursor: 'pointer', padding: '0 3.5px 10px' }}>
      <div style={{ position: 'relative' }}>
        {/* Bottom face — matches the preview tile's bottom-layer recipe:
            same color as the fill, with a 3.5px halo ring at 25% alpha.
            Top is shifted up by 3.5 (the halo's spread) so the halo's
            outer rounded shape extends all the way to the BlockRow's
            top edge — without that, a thin strip at the top of the row
            would have no halo and the page background would show through
            BlockRow's rounded corners while the row was lifted by the
            drag-shadow. The bottom face sits behind the top face, so
            the extra 3.5 of vertical extent isn't visible — only the
            halo it generates reaches the row edge. */}
        <div style={{
          position: 'absolute',
          left: 0, right: 0, top: 3.5, bottom: -6.5,
          borderRadius: 21,
          backgroundColor: bottomColor,
          boxShadow: `0 0 0 3.5px ${bottomColor}40`,
        }} />
        {/* Top face — sits inside the wrapper's 3.5px horizontal padding
            so the bottom face's halo ring fills that gap and lines up
            with the outer edges. */}
        <div style={{
          position: 'relative',
          borderRadius: 21,
          backgroundColor: '#FFFFFF',
          border: `2.5px solid ${BORDER}`,
          padding: '12px 14px',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
        }}>
          <GripVertical size={18} color={withAlpha(ON_SURFACE, 0.25)} />

          {/* Thumbnail */}
          {asFlow && flowPreviewItems.length > 0 ? (
            <WheelThumbnail items={flowPreviewItems[0]} size={44} />
          ) : block.type === 'roulette' && block.wheelConfig ? (
            <WheelThumbnail items={block.wheelConfig.items} size={44} />
          ) : (
            <div style={{
              width: 44, height: 44,
              borderRadius: '50%',
              backgroundColor: withAlpha(typeColor, 0.12),
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <TypeIcon size={22} color={typeColor} />
            </div>
          )}

          {/* Name + pills + stats */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 15, color: ON_SURFACE, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {block.name}
            </div>

            {/* Pills row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
              <Pill color={typeColor}>{asFlow ? 'Flow' : getBlockTypeLabel(block.type)}</Pill>
              <StatusPill published={isPublished} />
              {isChallenge && (
                <Pill color="#F59E0B">
                  <Trophy size={10} style={{ verticalAlign: 'middle', marginRight: 3 }} />
                  Challenge
                </Pill>
              )}
              <span style={{ fontSize: 11, fontWeight: 500, color: withAlpha(ON_SURFACE, 0.4) }}>
                {asFlow ? `${stepCount} step${stepCount === 1 ? '' : 's'}` : getBlockItemCountLabel(block)}
              </span>
            </div>

            {/* Stats row — only for published wheels */}
            {isPublished && stats && (
              <div style={{ display: 'flex', gap: 14, marginTop: 6, fontSize: 12, fontWeight: 600, color: withAlpha(ON_SURFACE, 0.55) }}>
                <StatInline icon={<Heart size={12} />} count={stats.likesCount} />
                <StatInline icon={<MessageCircle size={12} />} count={stats.commentsCount} />
                {isChallenge && <StatInline icon={<Trophy size={12} />} count={stats.responsesCount} />}
              </div>
            )}
          </div>

          {/* Edit chevron */}
          <div onClick={e => { e.stopPropagation(); onEdit(); }} style={{ padding: 8, cursor: 'pointer' }}>
            <ChevronRight size={20} color={withAlpha(ON_SURFACE, 0.3)} />
          </div>
        </div>
      </div>
    </div>
  );
}

function Pill({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span style={{
      padding: '2px 8px',
      borderRadius: 8,
      backgroundColor: withAlpha(color, 0.12),
      fontSize: 11,
      fontWeight: 700,
      color,
    }}>
      {children}
    </span>
  );
}

function StatusPill({ published }: { published: boolean }) {
  const color = published ? '#10B981' : withAlpha(ON_SURFACE, 0.45);
  const bg = published ? withAlpha('#10B981', 0.12) : withAlpha(ON_SURFACE, 0.06);
  return (
    <span style={{
      padding: '2px 8px',
      borderRadius: 8,
      backgroundColor: bg,
      fontSize: 11,
      fontWeight: 700,
      color,
    }}>
      {published ? 'Published' : 'Draft'}
    </span>
  );
}

function StatInline({ icon, count }: { icon: React.ReactNode; count: number }) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      {icon} {count}
    </span>
  );
}
