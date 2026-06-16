import { useReducer, useState } from 'react';
import { ROUGHNESS, ROUGHNESS_CONTROLS, ROUGHNESS_DEFAULTS, notifyRoughnessChanged } from './WheelCanvas';

// Dev-only floating panel of sliders for live-tuning the hand-drawn ROUGHNESS
// knobs. Mutates the ROUGHNESS object in place and pings every mounted
// SpinningWheel to re-bake. "Copy JSON" dumps the current values so they can be
// pasted back into the ROUGHNESS literal once they read right. Remove the mount
// (in RouletteScreen) + this file when done.
export default function RoughnessDebugPanel() {
  const [, force] = useReducer((x) => x + 1, 0);
  const [collapsed, setCollapsed] = useState(false);
  const [copied, setCopied] = useState(false);

  const set = (key: string, value: number | boolean) => {
    (ROUGHNESS as Record<string, number | boolean>)[key] = value;
    notifyRoughnessChanged();
    force();
  };

  const copy = () => {
    navigator.clipboard?.writeText(JSON.stringify(ROUGHNESS, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  const reset = () => {
    Object.assign(ROUGHNESS, ROUGHNESS_DEFAULTS);
    notifyRoughnessChanged();
    force();
  };

  const box: React.CSSProperties = {
    position: 'fixed', top: 8, right: 8, width: 248, maxHeight: '92vh',
    overflowY: 'auto', background: 'rgba(18,18,20,0.92)', color: '#eee',
    padding: 10, borderRadius: 8, zIndex: 99999,
    font: '11px/1.35 ui-monospace, monospace', boxShadow: '0 6px 24px rgba(0,0,0,0.5)',
    backdropFilter: 'blur(4px)',
  };
  const btn: React.CSSProperties = {
    background: '#333', color: '#eee', border: '1px solid #555',
    borderRadius: 4, padding: '2px 8px', cursor: 'pointer', font: 'inherit',
  };

  return (
    <div style={box}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6, marginBottom: collapsed ? 0 : 8 }}>
        <strong style={{ fontSize: 12 }}>🎨 roughness</strong>
        <div style={{ display: 'flex', gap: 4 }}>
          <button style={btn} onClick={copy}>{copied ? '✓' : 'copy'}</button>
          <button style={btn} onClick={reset}>reset</button>
          <button style={btn} onClick={() => setCollapsed((c) => !c)}>{collapsed ? '+' : '–'}</button>
        </div>
      </div>

      {!collapsed && (
        <>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
            <input type="checkbox" checked={ROUGHNESS.enabled} onChange={(e) => set('enabled', e.target.checked)} />
            enabled
          </label>

          {ROUGHNESS_CONTROLS.map((c) => {
            const v = ROUGHNESS[c.key];
            return (
              <div key={c.key} style={{ marginBottom: 9, opacity: ROUGHNESS.enabled ? 1 : 0.4 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
                  <span>{c.label}</span>
                  <span style={{ color: '#9cf' }}>{c.step < 0.01 ? v.toFixed(4) : v.toFixed(2)}</span>
                </div>
                <input
                  type="range"
                  min={c.min}
                  max={c.max}
                  step={c.step}
                  value={v}
                  onChange={(e) => set(c.key, parseFloat(e.target.value))}
                  style={{ width: '100%', accentColor: '#9cf' }}
                />
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
