import { Disc3, LayoutList, Compass, ChevronRight, Sparkles } from 'lucide-react';
import { BlockType } from '../models/types';
import { ON_SURFACE, BORDER } from '../utils/constants';
import { withAlpha } from '../utils/colorUtils';
import DraggableSheet from '../components/DraggableSheet';

interface CreateSheetProps {
  onTypeSelected: (type: BlockType) => void;
  onClose: () => void;
}

const EXPERIENCE_COLOR = '#c827d4';

// Roulette and List are demoted to "components" — they're useful, but the
// front-door creation path is Experience (multi-step, branching). One-step
// Experiences cover the bare-wheel use case.
const secondaryTypes: { type: BlockType; icon: typeof Disc3; color: string; title: string; subtitle: string }[] = [
  { type: 'roulette',       icon: Disc3,      color: '#38BDF8', title: 'Just a Roulette', subtitle: 'A single spinning wheel' },
  { type: 'listRandomizer', icon: LayoutList, color: '#88d515', title: 'Just a List',     subtitle: 'Randomize items across categories' },
];

export default function CreateSheet({ onTypeSelected, onClose }: CreateSheetProps) {
  return (
    <DraggableSheet onClose={onClose}>
      <div style={{ padding: '0 24px 32px' }}>
        <h3 style={{ fontSize: 20, fontWeight: 800, color: ON_SURFACE, margin: '0 0 6px' }}>
          What do you want to create?
        </h3>
        <p style={{ fontSize: 13, color: withAlpha(ON_SURFACE, 0.55), margin: '0 0 18px' }}>
          Build a multi-step Experience — wheels, lists, and branching all in one flow.
        </p>

        {/* Hero: Experience */}
        <div
          onClick={() => onTypeSelected('experience')}
          style={{
            position: 'relative',
            display: 'flex',
            alignItems: 'center',
            padding: '18px 18px',
            borderRadius: 22,
            border: `2px solid ${EXPERIENCE_COLOR}`,
            backgroundColor: withAlpha(EXPERIENCE_COLOR, 0.06),
            marginBottom: 18,
            cursor: 'pointer',
            userSelect: 'none',
          }}
        >
          <div style={{
            position: 'absolute',
            top: -10,
            left: 18,
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            padding: '3px 8px',
            borderRadius: 8,
            backgroundColor: EXPERIENCE_COLOR,
            color: '#FFF',
            fontSize: 10,
            fontWeight: 800,
            letterSpacing: 0.4,
          }}>
            <Sparkles size={11} /> RECOMMENDED
          </div>
          <div style={{
            width: 56, height: 56,
            borderRadius: '50%',
            backgroundColor: withAlpha(EXPERIENCE_COLOR, 0.18),
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}>
            <Compass size={28} color={EXPERIENCE_COLOR} />
          </div>
          <div style={{ flex: 1, marginLeft: 16 }}>
            <div style={{ fontSize: 17, fontWeight: 800, color: ON_SURFACE }}>Experience</div>
            <div style={{ fontSize: 13, color: withAlpha(ON_SURFACE, 0.65), marginTop: 3, lineHeight: 1.35 }}>
              Chain wheels and lists into a branching flow your audience plays through.
            </div>
          </div>
          <ChevronRight size={22} color={withAlpha(ON_SURFACE, 0.4)} />
        </div>

        <div style={{
          fontSize: 11,
          fontWeight: 700,
          color: withAlpha(ON_SURFACE, 0.4),
          letterSpacing: 0.6,
          margin: '0 4px 10px',
        }}>
          OR START WITH A SINGLE BLOCK
        </div>

        {secondaryTypes.map(({ type, icon: Icon, color, title, subtitle }) => (
          <div
            key={type}
            onClick={() => onTypeSelected(type)}
            style={{
              display: 'flex',
              alignItems: 'center',
              padding: '12px 14px',
              borderRadius: 16,
              border: `1px solid ${BORDER}`,
              marginBottom: 10,
              cursor: 'pointer',
              userSelect: 'none',
            }}
          >
            <div style={{
              width: 40, height: 40,
              borderRadius: '50%',
              backgroundColor: withAlpha(color, 0.15),
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}>
              <Icon size={20} color={color} />
            </div>
            <div style={{ flex: 1, marginLeft: 12 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: ON_SURFACE }}>{title}</div>
              <div style={{ fontSize: 12, color: withAlpha(ON_SURFACE, 0.55), marginTop: 1 }}>{subtitle}</div>
            </div>
            <ChevronRight size={18} color={withAlpha(ON_SURFACE, 0.3)} />
          </div>
        ))}
      </div>
    </DraggableSheet>
  );
}
