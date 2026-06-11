import { Shuffle, Sparkles, Play } from 'lucide-react';
import { withAlpha } from '../../utils/colorUtils';
import { ON_SURFACE } from '../../utils/constants';
import { ToggleRow } from './ToggleRow';

// Editor "Settings" pane — presentational. Spin behaviour + effect toggles.
interface SettingsPaneProps {
  isRandomIntensity: boolean;
  onIsRandomIntensityChange: (v: boolean) => void;
  spinIntensity: number;
  onSpinIntensityChange: (v: number) => void;
  showWinAnimation: boolean;
  onShowWinAnimationChange: (v: boolean) => void;
  showSpinButton: boolean;
  onShowSpinButtonChange: (v: boolean) => void;
}

export function SettingsPane({
  isRandomIntensity, onIsRandomIntensityChange,
  spinIntensity, onSpinIntensityChange,
  showWinAnimation, onShowWinAnimationChange,
  showSpinButton, onShowSpinButtonChange,
}: SettingsPaneProps) {
  return (
    <div style={{ padding: '0 20px 24px' }}>
      <ToggleRow
        label="Random Intensity"
        icon={<Shuffle size={22} />}
        value={isRandomIntensity}
        onChange={onIsRandomIntensityChange}
      />
      <div style={{ height: 12 }} />
      {!isRandomIntensity && (
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12, gap: 8 }}>
          <span style={{ width: 100, fontWeight: 600, fontSize: 14, color: withAlpha(ON_SURFACE, 0.6) }}>Intensity</span>
          <input
            type="range"
            min={0} max={1} step={0.05}
            value={spinIntensity}
            onChange={e => onSpinIntensityChange(parseFloat(e.target.value))}
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
        onChange={onShowWinAnimationChange}
      />
      <div style={{ height: 12 }} />
      {/* "Segment Header" lives in Style › Text & Images, co-located with the
          Header Text size it governs. */}
      <ToggleRow
        label="Spin Button"
        icon={<Play size={22} />}
        value={showSpinButton}
        onChange={onShowSpinButtonChange}
      />
    </div>
  );
}
