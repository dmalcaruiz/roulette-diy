import { useState } from 'react';
import { Block, BlockType, getBlockTypeLabel, getBlockItemCountLabel } from '../models/types';
import WheelThumbnail from '../components/WheelThumbnail';
import SwipeableActionCell from '../components/SwipeableActionCell';
import { oklchShadow, withAlpha } from '../utils/colorUtils';
import { ON_SURFACE, PRIMARY, BORDER } from '../utils/constants';
import {
  GripVertical, ChevronRight, LayoutGrid, Copy, Trash2,
  Disc3, LayoutList, Compass,
} from 'lucide-react';

type BlockFilter = 'all' | 'roulettes' | 'lists' | 'experiences';

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

interface MyBlocksScreenProps {
  blocks: Block[];
  onBlockTap: (block: Block) => void;
  onBlockEdit: (block: Block) => void;
  onBlockDuplicate: (block: Block) => void;
  onBlockDelete: (id: string) => void;
}

export default function MyBlocksScreen({
  blocks, onBlockTap, onBlockEdit, onBlockDuplicate, onBlockDelete,
}: MyBlocksScreenProps) {
  const [filter, setFilter] = useState<BlockFilter>('all');

  const filtered = blocks.filter(b => {
    if (filter === 'all') return true;
    if (filter === 'roulettes') return b.type === 'roulette';
    if (filter === 'lists') return b.type === 'listRandomizer';
    return b.type === 'experience';
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '24px 20px 16px' }}>
        <h1 style={{ fontSize: 28, fontWeight: 800, color: ON_SURFACE, margin: 0 }}>My Blocks</h1>
      </div>

      {/* Filter chips */}
      <div style={{ display: 'flex', gap: 8, padding: '0 20px', marginBottom: 12 }}>
        {(['all', 'roulettes', 'lists', 'experiences'] as BlockFilter[]).map(f => {
          const isActive = filter === f;
          const label = f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1);
          return (
            <div
              key={f}
              onClick={() => setFilter(f)}
              style={{
                padding: '8px 16px',
                borderRadius: 20,
                backgroundColor: isActive ? PRIMARY : 'transparent',
                border: `1.5px solid ${isActive ? PRIMARY : BORDER}`,
                fontSize: 13,
                fontWeight: 700,
                color: isActive ? '#FFFFFF' : withAlpha(ON_SURFACE, 0.6),
                cursor: 'pointer',
                transition: 'all 0.2s',
              }}
            >
              {label}
            </div>
          );
        })}
      </div>

      {/* Block list */}
      <div style={{ flex: 1, overflow: 'auto', padding: '0 20px' }}>
        {filtered.length === 0 ? (
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            padding: '0 40px',
          }}>
            <div style={{
              width: 72, height: 72,
              borderRadius: 22,
              backgroundColor: withAlpha(PRIMARY, 0.1),
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: 20,
            }}>
              <LayoutGrid size={36} color={PRIMARY} />
            </div>
            <div style={{ fontSize: 17, fontWeight: 700, color: withAlpha(ON_SURFACE, 0.45), textAlign: 'center' }}>
              {filter === 'all' ? 'No blocks yet' : `No ${filter} yet`}
            </div>
          </div>
        ) : (
          filtered.map(block => (
            <div key={block.id} style={{ marginBottom: 10 }}>
              <SwipeableActionCell
                trailingActions={[
                  { color: ROULETTE_COLOR, icon: <Copy size={20} />, onTap: () => onBlockDuplicate(block) },
                  { color: '#EF4444', icon: <Trash2 size={20} />, onTap: () => onBlockDelete(block.id), expandOnFullSwipe: true },
                ]}
              >
                <BlockCard block={block} onTap={() => onBlockTap(block)} onEdit={() => onBlockEdit(block)} />
              </SwipeableActionCell>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function BlockCard({ block, onTap, onEdit }: { block: Block; onTap: () => void; onEdit: () => void }) {
  const bottomColor = oklchShadow('#FFFFFF');
  const innerStrokeColor = oklchShadow('#FFFFFF', 0.06);
  const typeColor = colorForType(block.type);
  const TypeIcon = iconForType(block.type);

  return (
    <div onClick={onTap} style={{ height: 86.5, cursor: 'pointer' }}>
      <div style={{ position: 'relative', height: '100%' }}>
        {/* Bottom face */}
        <div style={{
          position: 'absolute',
          left: 0, right: 0, top: 6.5, bottom: 0,
          borderRadius: 21,
          backgroundColor: bottomColor,
          border: `2.5px solid ${innerStrokeColor}`,
        }} />
        {/* Top face */}
        <div style={{
          position: 'relative',
          height: 80,
          borderRadius: 21,
          backgroundColor: '#FFFFFF',
          border: `2.5px solid ${BORDER}`,
          padding: '0 14px',
          display: 'flex',
          alignItems: 'center',
        }}>
          <GripVertical size={18} color={withAlpha(ON_SURFACE, 0.25)} />
          <div style={{ width: 12 }} />

          {/* Thumbnail */}
          {block.type === 'roulette' && block.wheelConfig ? (
            <WheelThumbnail items={block.wheelConfig.items} size={44} />
          ) : (
            <div style={{
              width: 44, height: 44,
              borderRadius: '50%',
              backgroundColor: withAlpha(typeColor, 0.12),
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}>
              <TypeIcon size={22} color={typeColor} />
            </div>
          )}
          <div style={{ width: 14 }} />

          {/* Name + meta */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 15, color: ON_SURFACE, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {block.name}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
              <span style={{
                padding: '2px 8px',
                borderRadius: 8,
                backgroundColor: withAlpha(typeColor, 0.12),
                fontSize: 11,
                fontWeight: 700,
                color: typeColor,
              }}>
                {getBlockTypeLabel(block.type)}
              </span>
              <span style={{ fontSize: 12, fontWeight: 500, color: withAlpha(ON_SURFACE, 0.4) }}>
                {getBlockItemCountLabel(block)}
              </span>
            </div>
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
