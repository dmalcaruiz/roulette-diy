import { Block, BlockType, getBlockTypeLabel } from '../models/types';
import { PushDownButton } from '../components/PushDownButton';
import WheelThumbnail from '../components/WheelThumbnail';
import { oklchShadow, withAlpha } from '../utils/colorUtils';
import { ON_SURFACE, PRIMARY, BORDER } from '../utils/constants';
import { LayoutGrid, Plus, Circle, ListOrdered, Compass } from 'lucide-react';

interface HomeScreenProps {
  blocks: Block[];
  onCreateBlock: () => void;
  onBlockTap: (block: Block) => void;
}

function iconColorForType(type: BlockType): string {
  switch (type) {
    case 'roulette': return PRIMARY;
    case 'listRandomizer': return '#8B5CF6';
    case 'experience': return '#F97316';
  }
}

export default function HomeScreen({ blocks, onCreateBlock, onBlockTap }: HomeScreenProps) {
  if (blocks.length === 0) return <EmptyState onCreateBlock={onCreateBlock} />;

  const sorted = [...blocks].sort((a, b) =>
    new Date(b.lastUsedAt).getTime() - new Date(a.lastUsedAt).getTime()
  );
  const recent = sorted.slice(0, 3);

  return (
    <div style={{ overflow: 'auto', padding: '24px 20px 32px' }}>
      <h1 style={{ fontSize: 28, fontWeight: 800, color: ON_SURFACE, margin: '0 0 28px' }}>Home</h1>

      {/* Recent section */}
      <h2 style={{ fontSize: 18, fontWeight: 700, color: ON_SURFACE, margin: '0 0 14px' }}>Recent</h2>
      <div style={{ display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 8, marginBottom: 32 }}>
        {recent.map(block => (
          <RecentCard key={block.id} block={block} onClick={() => onBlockTap(block)} />
        ))}
      </div>

      {/* Quick Create */}
      <h2 style={{ fontSize: 18, fontWeight: 700, color: ON_SURFACE, margin: '0 0 14px' }}>Quick Create</h2>
      <div style={{ display: 'flex', gap: 10 }}>
        {[
          { icon: Circle, label: 'Roulette', color: PRIMARY },
          { icon: ListOrdered, label: 'List', color: '#8B5CF6' },
          { icon: Compass, label: 'Experience', color: '#F97316' },
        ].map(({ icon: Icon, label, color }) => (
          <div
            key={label}
            onClick={onCreateBlock}
            style={{
              flex: 1,
              padding: 14,
              borderRadius: 16,
              backgroundColor: withAlpha(color, 0.08),
              border: `1.5px solid ${withAlpha(color, 0.25)}`,
              textAlign: 'center',
              cursor: 'pointer',
            }}
          >
            <Icon size={24} color={color} />
            <div style={{ fontSize: 13, fontWeight: 700, color, marginTop: 6 }}>{label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function EmptyState({ onCreateBlock }: { onCreateBlock: () => void }) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100%',
      padding: '0 40px',
      textAlign: 'center',
    }}>
      <div style={{
        width: 80, height: 80,
        borderRadius: 24,
        backgroundColor: withAlpha(PRIMARY, 0.12),
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 24,
      }}>
        <LayoutGrid size={40} color={PRIMARY} />
      </div>
      <h2 style={{ fontSize: 22, fontWeight: 800, color: ON_SURFACE, margin: '0 0 10px' }}>No blocks yet</h2>
      <p style={{ fontSize: 15, fontWeight: 500, color: withAlpha(ON_SURFACE, 0.5), margin: '0 0 32px' }}>
        Create your first roulette, list, or experience to get started.
      </p>
      <PushDownButton color={PRIMARY} onTap={onCreateBlock}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: '#FFF', padding: '0 28px' }}>
          <Plus size={22} />
          <span style={{ fontWeight: 700, fontSize: 16 }}>Create Block</span>
        </div>
      </PushDownButton>
    </div>
  );
}

function RecentCard({ block, onClick }: { block: Block; onClick: () => void }) {
  const bottomColor = oklchShadow('#FFFFFF');
  const innerStrokeColor = oklchShadow('#FFFFFF', 0.06);
  const badgeColor = iconColorForType(block.type);

  return (
    <div onClick={onClick} style={{ width: 150, height: 120, flexShrink: 0, cursor: 'pointer' }}>
      <div style={{ position: 'relative', width: '100%', height: '100%' }}>
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
          height: 'calc(100% - 6.5px)',
          borderRadius: 21,
          backgroundColor: '#FFFFFF',
          border: `2.5px solid ${BORDER}`,
          padding: 14,
          display: 'flex',
          flexDirection: 'column',
        }}>
          {block.type === 'roulette' && block.wheelConfig ? (
            <WheelThumbnail items={block.wheelConfig.items} size={40} />
          ) : (
            <div style={{
              width: 40, height: 40,
              borderRadius: '50%',
              backgroundColor: withAlpha(badgeColor, 0.12),
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}>
              <LayoutGrid size={20} color={badgeColor} />
            </div>
          )}
          <div style={{ flex: 1, marginTop: 10, fontWeight: 700, fontSize: 14, color: ON_SURFACE, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {block.name}
          </div>
          <div style={{
            padding: '3px 8px',
            borderRadius: 8,
            backgroundColor: withAlpha(badgeColor, 0.1),
            fontSize: 11,
            fontWeight: 700,
            color: badgeColor,
            alignSelf: 'flex-start',
          }}>
            {getBlockTypeLabel(block.type)}
          </div>
        </div>
      </div>
    </div>
  );
}
