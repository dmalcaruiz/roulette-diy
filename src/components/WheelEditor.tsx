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

interface SegmentData {
  id: string;
  text: string;
  color: string;
  weight: number;
  imagePath?: string | null;
  iconName?: string | null;
}

interface WheelEditorProps {
  initialConfig?: WheelConfig | null;
  onPreview?: (config: WheelConfig) => void;
  onClose?: () => void;
}

let segmentIdCounter = 0;

function getNextColor(segments: SegmentData[]): string {
  return SEGMENT_COLORS[(segments.length - 1 + SEGMENT_COLORS.length) % SEGMENT_COLORS.length];
}

export default function WheelEditor({ initialConfig, onPreview, onClose }: WheelEditorProps) {
  const [name, setName] = useState(initialConfig?.name ?? 'New Wheel');
  const [segments, setSegments] = useState<SegmentData[]>(() => {
    if (initialConfig) {
      return initialConfig.items.map(item => ({
        id: `${segmentIdCounter++}`,
        text: item.text,
        color: item.color,
        weight: item.weight,
        imagePath: item.imagePath,
        iconName: item.iconName,
      }));
    }
    const id1 = `${segmentIdCounter++}`;
    const id2 = `${segmentIdCounter++}`;
    return [
      { id: id1, text: 'Option 1', color: SEGMENT_COLORS[9], weight: 1 },
      { id: id2, text: 'Option 2', color: SEGMENT_COLORS[0], weight: 1 },
    ];
  });

  const [textSize, setTextSize] = useState(initialConfig?.textSize ?? 1);
  const [headerTextSize, setHeaderTextSize] = useState(initialConfig?.headerTextSize ?? 1);
  const [imageSize, setImageSize] = useState(initialConfig?.imageSize ?? 60);
  const [cornerRadius, setCornerRadius] = useState(initialConfig?.cornerRadius ?? 8);
  const [strokeWidth, setStrokeWidth] = useState(initialConfig?.strokeWidth ?? 3);
  const [showBackgroundCircle, setShowBackgroundCircle] = useState(initialConfig?.showBackgroundCircle ?? true);
  const [centerMarkerSize, setCenterMarkerSize] = useState(initialConfig?.centerMarkerSize ?? 200);
  const [innerCornerStyle, setInnerCornerStyle] = useState<'none' | 'rounded' | 'circular' | 'straight'>(
    initialConfig?.innerCornerStyle ?? 'none'
  );
  const [centerInset, setCenterInset] = useState(initialConfig?.centerInset ?? 50);

  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const [selectedTab, setSelectedTab] = useState(0);
  const [colorPickerSegment, setColorPickerSegment] = useState<number | null>(null);

  const previewTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const triggerPreview = useCallback((segs?: SegmentData[]) => {
    const s = segs ?? segments;
    if (!onPreview || !name.trim()) return;
    const config: WheelConfig = {
      id: initialConfig?.id ?? Date.now().toString(),
      name: name.trim(),
      items: s.map(seg => ({
        text: seg.text,
        color: seg.color,
        weight: seg.weight,
        imagePath: seg.imagePath,
        iconName: seg.iconName,
      })),
      textSize,
      headerTextSize,
      imageSize,
      cornerRadius,
      imageCornerRadius: cornerRadius,
      strokeWidth,
      showBackgroundCircle,
      centerMarkerSize,
      innerCornerStyle,
      centerInset,
    };
    onPreview(config);
  }, [segments, name, textSize, headerTextSize, imageSize, cornerRadius, strokeWidth,
      showBackgroundCircle, centerMarkerSize, innerCornerStyle, centerInset, onPreview, initialConfig]);

  const updatePreview = useCallback((immediate = false, segs?: SegmentData[]) => {
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
    if (immediate) {
      triggerPreview(segs);
    } else {
      previewTimerRef.current = setTimeout(() => triggerPreview(segs), 150);
    }
  }, [triggerPreview]);

  // Initial preview
  useEffect(() => {
    updatePreview(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addSegment = () => {
    const id = `${segmentIdCounter++}`;
    const newSegs = [...segments, {
      id,
      text: `Option ${segments.length + 1}`,
      color: getNextColor(segments),
      weight: 1,
    }];
    setSegments(newSegs);
    updatePreview(true, newSegs);
  };

  const removeSegment = (index: number) => {
    if (segments.length <= 2) return;
    const newSegs = segments.filter((_, i) => i !== index);
    setSegments(newSegs);
    setExpandedIndex(null);
    updatePreview(true, newSegs);
  };

  const duplicateSegment = (index: number) => {
    const original = segments[index];
    const id = `${segmentIdCounter++}`;
    const newSegs = [...segments];
    newSegs.splice(index + 1, 0, { ...original, id });
    setSegments(newSegs);
    updatePreview(true, newSegs);
  };

  const updateSegment = (index: number, updates: Partial<SegmentData>) => {
    const newSegs = segments.map((s, i) => i === index ? { ...s, ...updates } : s);
    setSegments(newSegs);
    updatePreview(false, newSegs);
  };

  // Render segment card
  const renderSegmentCard = (segment: SegmentData, index: number) => {
    const isExpanded = expandedIndex === index;
    const bgColor = isExpanded ? '#FFFFFF' : segment.color;
    const borderColor = isExpanded ? segment.color : oklchShadow(segment.color, 0.06);
    const bottomColor = oklchShadow(isExpanded ? segment.color : segment.color);
    const textColor = isExpanded ? ON_SURFACE : '#FFFFFF';

    const card = (
      <div key={segment.id} style={{ marginBottom: 8 }}>
        {/* 3D Card */}
        <div style={{ position: 'relative' }}>
          {/* Bottom face */}
          <div style={{
            position: 'absolute',
            left: 0, right: 0, top: 6.5, bottom: 0,
            borderRadius: 21,
            backgroundColor: bottomColor,
            border: `2.5px solid ${oklchShadow(isExpanded ? segment.color : segment.color, 0.16)}`,
          }} />
          {/* Top face */}
          <div style={{
            position: 'relative',
            marginBottom: 6.5,
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
              <div style={{ padding: '0 14px' }}>
                <GripVertical size={22} color={isExpanded ? withAlpha(ON_SURFACE, 0.3) : 'rgba(255,255,255,0.6)'} />
              </div>
              <div style={{ flex: 1 }}>
                {isExpanded ? (
                  <InsetTextField
                    value={segment.text}
                    onChange={v => updateSegment(index, { text: v })}
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
                    onTap={() => updateSegment(index, { weight: Math.max(0.1, segment.weight - 0.1) })}
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
                    onTap={() => updateSegment(index, { weight: Math.min(10, segment.weight + 0.1) })}
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
                      onChange={c => updateSegment(index, { color: c })}
                      style={{ width: '100%' }}
                    />
                    <input
                      type="text"
                      value={colorToHex(segment.color)}
                      onChange={e => {
                        const c = hexStringToColor(e.target.value);
                        if (c) updateSegment(index, { color: c });
                      }}
                      maxLength={6}
                      style={{
                        marginTop: 8,
                        width: '100%',
                        padding: '8px 12px',
                        borderRadius: 10,
                        border: `1.5px solid ${BORDER}`,
                        fontSize: 14,
                        fontWeight: 600,
                        fontFamily: 'inherit',
                        outline: 'none',
                      }}
                    />
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
      <SettingSlider label="Segment Text" value={textSize} min={0.05} max={1.5} step={0.05}
        onChange={v => { setTextSize(v); updatePreview(); }} />
      <SettingSlider label="Header Text" value={headerTextSize} min={0.05} max={2} step={0.01}
        onChange={v => { setHeaderTextSize(v); updatePreview(); }} />
      <SettingSlider label="Image Size" value={imageSize} min={20} max={150} step={1}
        onChange={v => { setImageSize(v); updatePreview(); }} />
      <SettingSlider label="Corner Radius" value={cornerRadius} min={0} max={100} step={2.5}
        onChange={v => { setCornerRadius(v); updatePreview(); }} />

      {/* Inner corners dropdown */}
      <div style={{ display: 'flex', alignItems: 'center', padding: '4px', marginBottom: 12 }}>
        <span style={{ fontWeight: 600, fontSize: 14, color: '#71717A', width: 100 }}>Inner Corners</span>
        <div style={{ flex: 1 }} />
        <select
          value={innerCornerStyle}
          onChange={e => {
            setInnerCornerStyle(e.target.value as typeof innerCornerStyle);
            updatePreview();
          }}
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

      {innerCornerStyle !== 'none' && (
        <SettingSlider label="Center Inset" value={centerInset} min={0} max={150} step={1.5}
          onChange={v => { setCenterInset(v); updatePreview(); }} />
      )}

      <SettingSlider label="Stroke Width" value={strokeWidth} min={0} max={10} step={0.1}
        onChange={v => { setStrokeWidth(v); updatePreview(); }} />
      <SettingSlider label="Center Marker" value={centerMarkerSize} min={100} max={250} step={1}
        onChange={v => { setCenterMarkerSize(v); updatePreview(); }} />

      {/* Background circle toggle */}
      <div
        onClick={() => { setShowBackgroundCircle(!showBackgroundCircle); updatePreview(); }}
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '12px 16px',
          borderRadius: 14,
          backgroundColor: showBackgroundCircle ? withAlpha(PRIMARY, 0.12) : '#F4F4F5',
          border: `1.5px solid ${showBackgroundCircle ? PRIMARY : BORDER}`,
          cursor: 'pointer',
          marginTop: 8,
        }}
      >
        {showBackgroundCircle
          ? <CheckCircle size={22} color={PRIMARY} />
          : <Circle size={22} color={BORDER} />
        }
        <span style={{
          marginLeft: 12,
          fontWeight: 600,
          fontSize: 15,
          color: showBackgroundCircle ? ON_SURFACE : withAlpha(ON_SURFACE, 0.5),
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
        onChange={e => { setName(e.target.value); updatePreview(); }}
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
          {segments.map((seg, i) => renderSegmentCard(seg, i))}
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

function SettingSlider({ label, value, min, max, step, onChange }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
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
        style={{ flex: 1, accentColor: ON_SURFACE }}
      />
      <span style={{ width: 44, textAlign: 'right', fontWeight: 700, fontSize: 13 }}>
        {max > 10 ? value.toFixed(0) : value.toFixed(1)}
      </span>
    </div>
  );
}
