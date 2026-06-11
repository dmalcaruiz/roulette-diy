import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { withAlpha, oklchShadow, readableTextColor } from '../../utils/colorUtils';
import { ON_SURFACE, SURFACE_ELEVATED } from '../../utils/constants';
import { PushDownButton } from '../PushDownButton';
import { type SliceVibe } from './vibes';
import { VibeRow } from './VibeRow';
import { randomIdea, randomTitle, type WheelIdea } from './ideas';

// Editor "Templates" pane — presentational. Wheel title + vibe (palette) picker
// + an Ideas button. `onApplyVibe` recolours the slices; `onApplyIdea` fills the
// wheel with a themed starter set — the host owns the history for both.
interface TemplatesPaneProps {
  name: string;
  onNameChange: (name: string) => void;
  onNameCommit: () => void;
  sliceColors: string[];
  onApplyVibe: (vibe: SliceVibe) => void;
  onApplyIdea: (idea: WheelIdea) => void;
  onReorderActiveChange?: (active: boolean) => void;
}

const LABEL: React.CSSProperties = {
  fontSize: 13, fontWeight: 800, letterSpacing: 0.4,
  color: withAlpha(ON_SURFACE, 0.5), paddingLeft: 2,
};

export function TemplatesPane({ name, onNameChange, onNameCommit, sliceColors, onApplyVibe, onApplyIdea, onReorderActiveChange }: TemplatesPaneProps) {
  const [lastIdea, setLastIdea] = useState<WheelIdea | null>(null);
  return (
    <div style={{ padding: '0 20px 32px' }}>
      {/* Title — the wheel's name (same value as the top-bar pill). The
          sparkles button drops in a random fun name. */}
      <div style={{ marginTop: 4, marginBottom: 22 }}>
        <div style={{ ...LABEL, marginBottom: 8 }}>NAME</div>
        <div style={{ position: 'relative' }}>
          <input
            type="text"
            value={name}
            onChange={e => onNameChange(e.target.value)}
            onBlur={onNameCommit}
            placeholder="Wheel name"
            // Same inset slice-card field look, but colours DERIVE from the
            // sheet surface (bg + a shaded border + readable text) so it adapts
            // to the background instead of being a hardcoded light box. Height
            // pinned to the previous field; right padding clears the sparkles.
            style={{
              width: '100%', height: 46, boxSizing: 'border-box', padding: '0 44px 0 14px',
              border: `2.5px solid ${oklchShadow(SURFACE_ELEVATED, 0.06)}`, borderRadius: 14,
              backgroundColor: SURFACE_ELEVATED, color: readableTextColor(SURFACE_ELEVATED),
              fontSize: 17, fontWeight: 600, fontFamily: 'inherit', outline: 'none',
            }}
          />
          <button
            onClick={() => { const t = randomTitle(name); onNameChange(t); onNameCommit(); }}
            aria-label="Random title"
            style={{
              position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
              width: 34, height: 34, borderRadius: 9, border: 'none', cursor: 'pointer',
              background: 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <Sparkles size={18} color="#9B6DFF" />
          </button>
        </div>
      </div>
      {/* Vibe — a reorderable, scrollable row of slice-card-style palette tiles.
          Tap one to recolour all slices; long-press to reorder. */}
      <div style={{ marginBottom: 22 }}>
        <div style={{ ...LABEL, marginBottom: 6 }}>VIBE</div>
        <VibeRow sliceColors={sliceColors} onApplyVibe={onApplyVibe} onReorderActiveChange={onReorderActiveChange} />
      </div>
      {/* Ideas — fill the whole wheel with a random themed starter set. */}
      <div>
        <div style={{ ...LABEL, marginBottom: 10 }}>IDEAS</div>
        <PushDownButton
          color="#9B6DFF"
          onTap={() => { const idea = randomIdea(lastIdea); setLastIdea(idea); onApplyIdea(idea); }}
          borderRadius={32}
          innerStrokeWidth={3}
          height={54}
          bottomBorderWidth={6}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, color: '#FFFFFF' }}>
            <Sparkles size={20} />
            <span style={{ fontWeight: 700, fontSize: 16 }}>Surprise me</span>
          </div>
        </PushDownButton>
        <p style={{ fontSize: 13, fontWeight: 600, color: withAlpha(ON_SURFACE, 0.55), margin: '10px 4px 0', textAlign: 'center', minHeight: 18 }}>
          {lastIdea
            ? `${lastIdea.emoji} ${lastIdea.title} · ${lastIdea.options.length} slices`
            : 'Fills the wheel with a fun ready-made set.'}
        </p>
      </div>
    </div>
  );
}
