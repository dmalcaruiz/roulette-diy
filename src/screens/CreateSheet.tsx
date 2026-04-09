import { Disc3, LayoutList, Compass, ChevronRight } from 'lucide-react';
import { BlockType } from '../models/types';
import { ON_SURFACE, BORDER } from '../utils/constants';
import { withAlpha } from '../utils/colorUtils';
import DraggableSheet from '../components/DraggableSheet';

interface CreateSheetProps {
  onTypeSelected: (type: BlockType) => void;
  onClose: () => void;
}

const types: { type: BlockType; icon: typeof Disc3; color: string; title: string; subtitle: string }[] = [
  { type: 'roulette', icon: Disc3, color: '#38BDF8', title: 'Roulette', subtitle: 'Spin a wheel to pick a random option' },
  { type: 'listRandomizer', icon: LayoutList, color: '#88d515', title: 'List Randomizer', subtitle: 'Randomize items across categories' },
  { type: 'experience', icon: Compass, color: '#c827d4', title: 'Experience', subtitle: 'Chain blocks into a guided flow' },
];

export default function CreateSheet({ onTypeSelected, onClose }: CreateSheetProps) {
  return (
    <DraggableSheet onClose={onClose}>
      <div style={{ padding: '0 24px 32px' }}>
        <h3 style={{ fontSize: 20, fontWeight: 800, color: ON_SURFACE, margin: '0 0 20px' }}>
          What do you want to create?
        </h3>
        {types.map(({ type, icon: Icon, color, title, subtitle }) => (
          <div
            key={type}
            onClick={() => onTypeSelected(type)}
            style={{
              display: 'flex',
              alignItems: 'center',
              padding: '14px 16px',
              borderRadius: 18,
              border: `1px solid ${BORDER}`,
              marginBottom: 12,
              cursor: 'pointer',
              userSelect: 'none',
            }}
          >
            <div style={{
              width: 48, height: 48,
              borderRadius: '50%',
              backgroundColor: withAlpha(color, 0.15),
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}>
              <Icon size={24} color={color} />
            </div>
            <div style={{ flex: 1, marginLeft: 14 }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: ON_SURFACE }}>{title}</div>
              <div style={{ fontSize: 13, color: withAlpha(ON_SURFACE, 0.55), marginTop: 2 }}>{subtitle}</div>
            </div>
            <ChevronRight size={20} color={withAlpha(ON_SURFACE, 0.35)} />
          </div>
        ))}
      </div>
    </DraggableSheet>
  );
}
