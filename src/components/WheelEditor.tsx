import { useState, useCallback, useRef, useEffect } from 'react';
import { WheelConfig, WheelItem } from '../models/types';
import { InsetTextField, PushDownButton } from './PushDownButton';
import { oklchShadow, withAlpha, colorToHex, hexStringToColor } from '../utils/colorUtils';
import { HexColorPicker } from 'react-colorful';
import { SEGMENT_COLORS, ON_SURFACE, BORDER, PRIMARY } from '../utils/constants';
import {
  GripVertical, ChevronDown, Plus, Minus, Palette, Image, Trash2,
  Copy, LayoutList, Paintbrush, X, CheckCircle, Circle, Settings,
} from 'lucide-react';
import SwipeableActionCell from './SwipeableActionCell';
import { HistoryControls } from '../hooks/useHistory';

interface SegmentData {
  id: string;
  text: string;
  color: string;
  weight: number;
  imagePath?: string | null;
  iconName?: string | null;
}

export interface EditorState {
  segments: SegmentData[];
  name: string;
  textSize: number;
  headerTextSize: number;
  imageSize: number;
  cornerRadius: number;
  strokeWidth: number;
  showBackgroundCircle: boolean;
  centerMarkerSize: number;
  innerCornerStyle: 'none' | 'rounded' | 'circular' | 'straight';
  centerInset: number;
}

interface WheelEditorProps {
  initialConfig?: WheelConfig | null;
  history: HistoryControls<EditorState>;
  onPreview?: (config: WheelConfig) => void;
  onClose?: () => void;
  // Optional controlled tab. If provided, the editor renders that tab and
  // calls onTabChange when the user taps a tab header. If omitted, the
  // editor manages its own tab state (legacy behavior).
  selectedTab?: number;
  onTabChange?: (tab: number) => void;
}

let segmentIdCounter = 0;

function getNextColor(segments: SegmentData[]): string {
  return SEGMENT_COLORS[(segments.length - 1 + SEGMENT_COLORS.length) % SEGMENT_COLORS.length];
}

export function buildInitialState(config?: WheelConfig | null): EditorState {
  const segments: SegmentData[] = config
    ? config.items.map(item => ({
        id: `${segmentIdCounter++}`,
        text: item.text,
        color: item.color,
        weight: item.weight,
        imagePath: item.imagePath,
        iconName: item.iconName,
      }))
    : [
        { id: `${segmentIdCounter++}`, text: 'Option 1', color: SEGMENT_COLORS[9], weight: 1 },
        { id: `${segmentIdCounter++}`, text: 'Option 2', color: SEGMENT_COLORS[0], weight: 1 },
      ];

  return {
    segments,
    name: config?.name ?? 'New Wheel',
    textSize: config?.textSize ?? 1,
    headerTextSize: config?.headerTextSize ?? 1,
    imageSize: config?.imageSize ?? 60,
    cornerRadius: config?.cornerRadius ?? 8,
    strokeWidth: config?.strokeWidth ?? 3,
    showBackgroundCircle: config?.showBackgroundCircle ?? true,
    centerMarkerSize: config?.centerMarkerSize ?? 200,
    innerCornerStyle: config?.innerCornerStyle ?? 'none',
    centerInset: config?.centerInset ?? 50,
  };
}

export function stateToConfig(state: EditorState, id: string): WheelConfig {
  return {
    id,
    name: state.name.trim(),
    items: state.segments.map(seg => ({
      text: seg.text,
      color: seg.color,
      weight: seg.weight,
      imagePath: seg.imagePath,
      iconName: seg.iconName,
    })),
    textSize: state.textSize,
    headerTextSize: state.headerTextSize,
    imageSize: state.imageSize,
    cornerRadius: state.cornerRadius,
    imageCornerRadius: state.cornerRadius,
    strokeWidth: state.strokeWidth,
    showBackgroundCircle: state.showBackgroundCircle,
    centerMarkerSize: state.centerMarkerSize,
    innerCornerStyle: state.innerCornerStyle,
    centerInset: state.centerInset,
  };
}

export default function WheelEditor({
  initialConfig, history, onPreview, onClose,
  selectedTab: selectedTabProp, onTabChange,
}: WheelEditorProps) {
  const configId = initialConfig?.id ?? Date.now().toString();
  const { state, set, patch, commit, undo, redo } = history;
  const { segments, name } = state;

  // UI-only state
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const [internalTab, setInternalTab] = useState(0);
  const selectedTab = selectedTabProp ?? internalTab;
  const setSelectedTab = (t: number) => {
    if (onTabChange) onTabChange(t);
    if (selectedTabProp === undefined) setInternalTab(t);
  };
  const [colorPickerSegment, setColorPickerSegment] = useState<number | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const segmentElsRef = useRef<(HTMLDivElement | null)[]>([]);
  const segmentsRef = useRef(segments);
  segmentsRef.current = segments;

  // Keep a ref to current state for use in pointer handlers
  const stateRef = useRef(state);
  stateRef.current = state;

  // Initial preview
  useEffect(() => {
    if (!onPreview || !state.name.trim()) return;
    onPreview(stateToConfig(state, configId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Discrete actions (push to history) ---

  const addSegment = () => {
    const id = `${segmentIdCounter++}`;
    set({
      ...stateRef.current,
      segments: [...stateRef.current.segments, {
        id,
        text: `Option ${stateRef.current.segments.length + 1}`,
        color: getNextColor(stateRef.current.segments),
        weight: 1,
      }],
    });
  };

  const removeSegment = (index: number) => {
    if (stateRef.current.segments.length <= 2) return;
    set({
      ...stateRef.current,
      segments: stateRef.current.segments.filter((_, i) => i !== index),
    });
    setExpandedIndex(null);
  };

  const duplicateSegment = (index: number) => {
    const original = stateRef.current.segments[index];
    const id = `${segmentIdCounter++}`;
    const newSegs = [...stateRef.current.segments];
    newSegs.splice(index + 1, 0, { ...original, id });
    set({ ...stateRef.current, segments: newSegs });
  };

  // --- Continuous actions (patch, commit on end) ---

  const patchSegment = (index: number, updates: Partial<SegmentData>) => {
    const newSegs = state.segments.map((s, i) => i === index ? { ...s, ...updates } : s);
    patch({ segments: newSegs });
  };

  // --- Drag reorder ---

  const handleGripPointerDown = useCallback((index: number, e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();

    const startX = e.clientX;
    const startY = e.clientY;
    const dragId = segmentsRef.current[index].id;
    let dragActivated = false;
    let decided = false;
    let currentIndex = index;

    const onMove = (me: PointerEvent) => {
      const dx = me.clientX - startX;
      const dy = me.clientY - startY;

      if (!decided) {
        if (Math.abs(dy) > 8) {
          decided = true;
          dragActivated = true;
          setDraggingId(dragId);
          setExpandedIndex(null);
        } else if (Math.abs(dx) > 8) {
          decided = true;
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          return;
        }
        return;
      }

      if (!dragActivated) return;

      let target = segmentsRef.current.length - 1;
      const els = segmentElsRef.current;
      for (let i = 0; i < els.length; i++) {
        const el = els[i];
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        if (me.clientY < rect.top + rect.height / 2) {
          target = i;
          break;
        }
      }
      target = Math.max(0, Math.min(target, segmentsRef.current.length - 1));

      if (target !== currentIndex) {
        const newSegs = [...segmentsRef.current];
        const [moved] = newSegs.splice(currentIndex, 1);
        newSegs.splice(target, 0, moved);
        // Use patch for live visual feedback during drag
        patch({ segments: newSegs });
        currentIndex = target;
      }
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);

      if (dragActivated) {
        setDraggingId(null);
        // Commit the reorder as a discrete action
        commit();
      }

      if (!decided) {
        setExpandedIndex(prev => prev === index ? null : index);
      }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [patch, commit]);

  // --- Keyboard shortcut ---
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
          redo();
        } else {
          undo();
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [undo, redo]);

  // Render segment card
  const renderSegmentCard = (segment: SegmentData, index: number) => {
    const isExpanded = expandedIndex === index;
    const bgColor = isExpanded ? '#FFFFFF' : segment.color;
    const borderColor = isExpanded ? segment.color : oklchShadow(segment.color, 0.06);
    const bottomColor = oklchShadow(isExpanded ? segment.color : segment.color);
    const textColor = isExpanded ? ON_SURFACE : '#FFFFFF';

    const card = (
      <div key={segment.id} style={{ marginBottom: 8, paddingBottom: 6.5 }}>
        {/* 3D Card */}
        <div style={{ position: 'relative' }}>
          {/* Bottom face */}
          <div style={{
            position: 'absolute',
            left: 0, right: 0, top: 6.5, bottom: -6.5,
            borderRadius: 21,
            backgroundColor: bottomColor,
            border: `2.5px solid ${oklchShadow(isExpanded ? segment.color : segment.color, 0.16)}`,
          }} />
          {/* Top face */}
          <div style={{
            position: 'relative',
            borderRadius: 21,
            backgroundColor: bgColor,
            border: `${isExpanded ? 3 : 2.5}px solid ${borderColor}`,
            overflow: 'hidden',
            transition: 'background-color 0.2s, border-color 0.2s',
          }}>
            {/* Collapsed row */}
            <div
              onClick={() => setExpandedIndex(isExpanded ? null : index)}
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '8px 0',
                cursor: 'pointer',
              }}
            >
              <div
                style={{ padding: '0 14px', touchAction: 'none', cursor: isExpanded ? 'default' : 'grab' }}
                onPointerDown={isExpanded ? undefined : (e) => handleGripPointerDown(index, e)}
              >
                <GripVertical size={22} color={isExpanded ? withAlpha(ON_SURFACE, 0.3) : 'rgba(255,255,255,0.6)'} />
              </div>
              <div
                style={{ flex: 1 }}
                onClick={isExpanded ? (e) => e.stopPropagation() : undefined}
                onPointerDown={isExpanded ? (e) => e.stopPropagation() : undefined}
              >
                {isExpanded ? (
                  <InsetTextField
                    value={segment.text}
                    onChange={v => patchSegment(index, { text: v })}
                    onBlur={commit}
                    placeholder="Segment name"
                    inputStyle={{ fontWeight: 600, fontSize: 16, color: ON_SURFACE }}
                  />
                ) : (
                  <div style={{
                    padding: '10px 12px',
                    fontWeight: 600,
                    fontSize: 16,
                    color: textColor,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}>
                    {segment.text}
                  </div>
                )}
              </div>
              <div style={{
                padding: '0 14px',
                transform: `rotate(${isExpanded ? 180 : 0}deg)`,
                transition: 'transform 0.2s',
              }}>
                <ChevronDown size={26} color={isExpanded ? withAlpha(ON_SURFACE, 0.35) : 'rgba(255,255,255,0.6)'} />
              </div>
            </div>

            {/* Expanded content */}
            {isExpanded && (
              <div
                onClick={e => e.stopPropagation()}
                style={{ padding: '0 14px 14px' }}
              >
                {/* Weight controls */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                  <PushDownButton
                    color="#F4F4F5"
                    borderRadius={10}
                    height={36}
                    bottomBorderWidth={3}
                    onTap={() => {
                      const newSegs = state.segments.map((s, i) =>
                        i === index ? { ...s, weight: Math.max(0.1, s.weight - 0.1) } : s
                      );
                      set({ ...state, segments: newSegs });
                    }}
                    style={{ width: 36 }}
                  >
                    <Minus size={16} color={ON_SURFACE} />
                  </PushDownButton>
                  <div style={{ flex: 1, textAlign: 'center', fontWeight: 700, fontSize: 14 }}>
                    Weight: {segment.weight.toFixed(1)}
                  </div>
                  <PushDownButton
                    color="#F4F4F5"
                    borderRadius={10}
                    height={36}
                    bottomBorderWidth={3}
                    onTap={() => {
                      const newSegs = state.segments.map((s, i) =>
                        i === index ? { ...s, weight: Math.min(10, s.weight + 0.1) } : s
                      );
                      set({ ...state, segments: newSegs });
                    }}
                    style={{ width: 36 }}
                  >
                    <Plus size={16} color={ON_SURFACE} />
                  </PushDownButton>
                </div>

                {/* Color + image buttons */}
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    onClick={() => setColorPickerSegment(colorPickerSegment === index ? null : index)}
                    style={{
                      flex: 1,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 8,
                      padding: '10px 16px',
                      borderRadius: 12,
                      backgroundColor: '#F4F4F5',
                      border: `1.5px solid ${BORDER}`,
                      cursor: 'pointer',
                      fontSize: 14,
                      fontWeight: 600,
                    }}
                  >
                    <Palette size={18} />
                    <div style={{
                      width: 20, height: 20,
                      borderRadius: '50%',
                      backgroundColor: segment.color,
                      border: `1.5px solid ${BORDER}`,
                    }} />
                  </button>
                </div>

                {/* Inline color picker */}
                {colorPickerSegment === index && (
                  <div style={{ marginTop: 12 }}>
                    <HexColorPicker
                      color={segment.color}
                      onChange={c => patchSegment(index, { color: c })}
                      style={{ width: '100%' }}
                    />
                    <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                      <input
                        type="text"
                        value={colorToHex(segment.color)}
                        onChange={e => {
                          const c = hexStringToColor(e.target.value);
                          if (c) patchSegment(index, { color: c });
                        }}
                        onBlur={commit}
                        maxLength={6}
                        style={{
                          flex: 1,
                          padding: '8px 12px',
                          borderRadius: 10,
                          border: `1.5px solid ${BORDER}`,
                          fontSize: 14,
                          fontWeight: 600,
                          fontFamily: 'inherit',
                          outline: 'none',
                        }}
                      />
                      <button
                        onClick={() => { commit(); setColorPickerSegment(null); }}
                        style={{
                          padding: '8px 16px',
                          borderRadius: 10,
                          backgroundColor: ON_SURFACE,
                          color: '#FFFFFF',
                          border: 'none',
                          fontWeight: 700,
                          fontSize: 13,
                          cursor: 'pointer',
                        }}
                      >
                        Done
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    );

    // Wrap with swipeable actions
    return (
      <SwipeableActionCell
        key={segment.id}
        trailingActions={[
          {
            color: PRIMARY,
            icon: <Copy size={20} />,
            onTap: () => duplicateSegment(index),
          },
          {
            color: '#EF4444',
            icon: <Trash2 size={20} />,
            onTap: () => removeSegment(index),
            expandOnFullSwipe: true,
          },
        ]}
      >
        {card}
      </SwipeableActionCell>
    );
  };

  // Render style tab
  const renderStyleTab = () => (
    <div style={{ paddingTop: 16 }}>
      <SettingSlider label="Segment Text" value={state.textSize} min={0.05} max={1.5} step={0.05}
        onChange={v => patch({ textSize: v })} onChangeEnd={commit} />
      <SettingSlider label="Header Text" value={state.headerTextSize} min={0.05} max={2} step={0.01}
        onChange={v => patch({ headerTextSize: v })} onChangeEnd={commit} />
      <SettingSlider label="Image Size" value={state.imageSize} min={20} max={150} step={1}
        onChange={v => patch({ imageSize: v })} onChangeEnd={commit} />
      <SettingSlider label="Corner Radius" value={state.cornerRadius} min={0} max={100} step={2.5}
        onChange={v => patch({ cornerRadius: v })} onChangeEnd={commit} />

      {/* Inner corners dropdown */}
      <div style={{ display: 'flex', alignItems: 'center', padding: '4px', marginBottom: 12 }}>
        <span style={{ fontWeight: 600, fontSize: 14, color: '#71717A', width: 100 }}>Inner Corners</span>
        <div style={{ flex: 1 }} />
        <select
          value={state.innerCornerStyle}
          onChange={e => set({ ...state, innerCornerStyle: e.target.value as EditorState['innerCornerStyle'] })}
          style={{
            padding: '6px 12px',
            borderRadius: 10,
            border: `1.5px solid ${BORDER}`,
            backgroundColor: '#F4F4F5',
            fontWeight: 600,
            fontSize: 14,
            fontFamily: 'inherit',
            outline: 'none',
            cursor: 'pointer',
          }}
        >
          <option value="none">None</option>
          <option value="circular">Circular</option>
          <option value="rounded">Rounded</option>
          <option value="straight">Straight</option>
        </select>
      </div>

      {state.innerCornerStyle !== 'none' && (
        <SettingSlider label="Center Inset" value={state.centerInset} min={0} max={150} step={1.5}
          onChange={v => patch({ centerInset: v })} onChangeEnd={commit} />
      )}

      <SettingSlider label="Stroke Width" value={state.strokeWidth} min={0} max={10} step={0.1}
        onChange={v => patch({ strokeWidth: v })} onChangeEnd={commit} />
      <SettingSlider label="Center Marker" value={state.centerMarkerSize} min={100} max={250} step={1}
        onChange={v => patch({ centerMarkerSize: v })} onChangeEnd={commit} />

      {/* Background circle toggle */}
      <div
        onClick={() => set({ ...state, showBackgroundCircle: !state.showBackgroundCircle })}
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '12px 16px',
          borderRadius: 14,
          backgroundColor: state.showBackgroundCircle ? withAlpha(PRIMARY, 0.12) : '#F4F4F5',
          border: `1.5px solid ${state.showBackgroundCircle ? PRIMARY : BORDER}`,
          cursor: 'pointer',
          marginTop: 8,
        }}
      >
        {state.showBackgroundCircle
          ? <CheckCircle size={22} color={PRIMARY} />
          : <Circle size={22} color={BORDER} />
        }
        <span style={{
          marginLeft: 12,
          fontWeight: 600,
          fontSize: 15,
          color: state.showBackgroundCircle ? ON_SURFACE : withAlpha(ON_SURFACE, 0.5),
        }}>
          Background Circle
        </span>
      </div>

      <div style={{ height: 32 }} />
    </div>
  );

  return (
    <div style={{
      overflowY: 'auto',
      padding: '0 20px 16px',
      height: '100%',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 13 }}>
        <h2 style={{ flex: 1, fontSize: 22, fontWeight: 700, margin: 0 }}>Edit Wheel</h2>
        {onClose && (
          <div onClick={onClose} style={{
            width: 32, height: 32,
            borderRadius: 50,
            backgroundColor: '#F4F4F5',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
          }}>
            <X size={16} color={ON_SURFACE} />
          </div>
        )}
      </div>

      {/* Name field */}
      <input
        type="text"
        value={name}
        onChange={e => patch({ name: e.target.value })}
        onBlur={commit}
        style={{
          width: '100%',
          padding: '14px 16px',
          borderRadius: 14,
          border: `1.5px solid ${BORDER}`,
          backgroundColor: '#F8F8F9',
          fontSize: 17,
          fontWeight: 600,
          fontFamily: 'inherit',
          outline: 'none',
          marginBottom: 16,
        }}
      />

      {/* Tab bar */}
      <div style={{
        display: 'flex',
        height: 48,
        backgroundColor: '#E4E4E7',
        borderRadius: 16,
        padding: 4,
        marginBottom: 14,
      }}>
        {['Segments', 'Style'].map((label, i) => {
          const isActive = selectedTab === i;
          const Icon = i === 0 ? LayoutList : Paintbrush;
          return (
            <div
              key={label}
              onClick={() => setSelectedTab(i)}
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                borderRadius: 14,
                backgroundColor: isActive ? '#FFFFFF' : 'transparent',
                border: isActive ? `1.5px solid ${BORDER}` : '1.5px solid transparent',
                boxShadow: isActive ? '0 2px 6px rgba(0,0,0,0.08)' : 'none',
                cursor: 'pointer',
                transition: 'all 0.2s',
              }}
            >
              <Icon size={16} color={isActive ? ON_SURFACE : withAlpha(ON_SURFACE, 0.4)} />
              <span style={{
                fontSize: 14,
                fontWeight: 700,
                color: isActive ? ON_SURFACE : withAlpha(ON_SURFACE, 0.4),
              }}>
                {label}
              </span>
            </div>
          );
        })}
      </div>

      {/* Tab content */}
      {selectedTab === 1 ? renderStyleTab() : (
        <>
          {segments.map((seg, i) => (
            <div
              key={seg.id}
              ref={el => { segmentElsRef.current[i] = el; }}
              style={{ opacity: draggingId === seg.id ? 0.4 : 1, transition: 'opacity 0.15s' }}
            >
              {renderSegmentCard(seg, i)}
            </div>
          ))}
          <div style={{ height: 12 }} />
          <PushDownButton color={ON_SURFACE} onTap={addSegment}>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 10,
              color: '#FFFFFF',
            }}>
              <Plus size={22} />
              <span style={{ fontWeight: 700, fontSize: 15 }}>Add Segment</span>
            </div>
          </PushDownButton>
          <div style={{ height: 32 }} />
        </>
      )}
    </div>
  );
}

// ── Setting Slider ────────────────────────────────────────────────────────

function SettingSlider({ label, value, min, max, step, onChange, onChangeEnd }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  onChangeEnd?: () => void;
}) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      marginBottom: 12,
    }}>
      <span style={{ width: 100, fontWeight: 600, fontSize: 14 }}>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        onPointerUp={onChangeEnd}
        onTouchEnd={onChangeEnd}
        style={{ flex: 1, accentColor: ON_SURFACE }}
      />
      <span style={{ width: 44, textAlign: 'right', fontWeight: 700, fontSize: 13 }}>
        {max > 10 ? value.toFixed(0) : value.toFixed(1)}
      </span>
    </div>
  );
}
