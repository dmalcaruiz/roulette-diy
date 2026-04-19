import { useState } from 'react';
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
  showFilters?: boolean;    // hide filter chips when embedded in smaller contexts
}

export default function BlocksList({
  blocks, onBlockTap, onBlockEdit, onBlockDuplicate, onBlockDelete,
  showFilters = true,
}: BlocksListProps) {
  const [filter, setFilter] = useState<BlockFilter>('all');
  const stats = usePublishedStats(blocks);

  const filtered = blocks.filter(b => {
    if (filter === 'all') return true;
    if (filter === 'roulettes') return b.type === 'roulette';
    if (filter === 'lists') return b.type === 'listRandomizer';
    return b.type === 'experience';
  });

  return (
    <div>
      {showFilters && (
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
        filtered.map(block => (
          <div key={block.id} style={{ marginBottom: 10 }}>
            <SwipeableActionCell
              trailingActions={[
                { color: ROULETTE_COLOR, icon: <Copy size={20} />, onTap: () => onBlockDuplicate(block) },
                { color: '#EF4444', icon: <Trash2 size={20} />, onTap: () => onBlockDelete(block.id), expandOnFullSwipe: true },
              ]}
            >
              <BlockCard
                block={block}
                stats={block.publishedWheelId ? stats.get(block.publishedWheelId) : undefined}
                onTap={() => onBlockTap(block)}
                onEdit={() => onBlockEdit(block)}
              />
            </SwipeableActionCell>
          </div>
        ))
      )}
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

function BlockCard({ block, stats, onTap, onEdit }: {
  block: CloudBlock;
  stats?: BlockStats;
  onTap: () => void;
  onEdit: () => void;
}) {
  const bottomColor = oklchShadow('#FFFFFF');
  const innerStrokeColor = oklchShadow('#FFFFFF', 0.06);
  const typeColor = colorForType(block.type);
  const TypeIcon = iconForType(block.type);
  const isPublished = !!block.publishedWheelId;
  const isChallenge = stats?.isChallenge ?? false;

  return (
    <div onClick={onTap} style={{ cursor: 'pointer' }}>
      <div style={{ position: 'relative' }}>
        {/* Bottom face */}
        <div style={{
          position: 'absolute',
          left: 0, right: 0, top: 6.5, bottom: -6.5,
          borderRadius: 21,
          backgroundColor: bottomColor,
          border: `2.5px solid ${innerStrokeColor}`,
        }} />
        {/* Top face */}
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
          {block.type === 'roulette' && block.wheelConfig ? (
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
              <Pill color={typeColor}>{getBlockTypeLabel(block.type)}</Pill>
              <StatusPill published={isPublished} />
              {isChallenge && (
                <Pill color="#F59E0B">
                  <Trophy size={10} style={{ verticalAlign: 'middle', marginRight: 3 }} />
                  Challenge
                </Pill>
              )}
              <span style={{ fontSize: 11, fontWeight: 500, color: withAlpha(ON_SURFACE, 0.4) }}>
                {getBlockItemCountLabel(block)}
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
