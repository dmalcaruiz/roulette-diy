import { useState, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Block, WheelConfig } from '../models/types';
import SpinningWheel, { SpinningWheelHandle } from '../components/SpinningWheel';
import WheelEditor, { buildInitialState, EditorState, stateToConfig } from '../components/WheelEditor';
import { PushDownButton } from '../components/PushDownButton';
import { withAlpha } from '../utils/colorUtils';
import { ON_SURFACE, PRIMARY } from '../utils/constants';
import { ArrowLeft, Settings, Pencil, Shuffle, Sparkles, Play, X, Undo2, Redo2 } from 'lucide-react';
import DraggableSheet from '../components/DraggableSheet';
import SnappingSheet from '../components/SnappingSheet';
import { useHistory } from '../hooks/useHistory';

interface RouletteScreenProps {
  block: Block;
  editMode?: boolean;
  onBlockUpdated?: (block: Block) => void;
}

export default function RouletteScreen({ block, editMode = false, onBlockUpdated }: RouletteScreenProps) {
  const navigate = useNavigate();
  const wheelRef = useRef<SpinningWheelHandle>(null);
  const [backgroundColor, setBackgroundColor] = useState('#000000');
  const [textColor, setTextColor] = useState('#FFFFFF');
  const [overlayColor, setOverlayColor] = useState('#000000');
  const [currentConfig, setCurrentConfig] = useState<WheelConfig>(block.wheelConfig!);
  const [previewConfig, setPreviewConfig] = useState<WheelConfig | null>(null);
  const [isEditMode, setIsEditMode] = useState(editMode);
  const [spinIntensity, setSpinIntensity] = useState(0.5);
  const [isRandomIntensity, setIsRandomIntensity] = useState(true);
  const [showWinAnimation, setShowWinAnimation] = useState(true);
  const [showEditor, setShowEditor] = useState(editMode);
  const [showGearMenu, setShowGearMenu] = useState(false);
  const [isPlayMode, setIsPlayMode] = useState(false);
  const [sheetHeight, setSheetHeight] = useState(0);
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const activeConfig = previewConfig ?? currentConfig;
  const screenWidth = window.innerWidth;
  const screenHeight = window.innerHeight;
  const isMobile = screenWidth < 900;
  const idealWheelSize = 700;
  const availableWidth = isMobile ? (screenWidth - 16) : (screenWidth - 400 - 32);
  const effectiveWheelSize = Math.min(availableWidth, idealWheelSize);

  const onWheelFinished = useCallback((index: number) => {
    const updated = { ...block, lastUsedAt: new Date().toISOString() };
    onBlockUpdated?.(updated);
  }, [block, onBlockUpdated]);

  const handleWheelPreview = useCallback((config: WheelConfig) => {
    setPreviewConfig(config);
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = setTimeout(() => {
      setCurrentConfig(config);
      const updated = { ...block, name: config.name, wheelConfig: config };
      onBlockUpdated?.(updated);
    }, 500);
  }, [block, onBlockUpdated]);

  const configId = block.wheelConfig?.id ?? Date.now().toString();
  const handleHistoryChange = useCallback((s: EditorState) => {
    if (!s.name.trim()) return;
    handleWheelPreview(stateToConfig(s, configId));
  }, [handleWheelPreview, configId]);
  const editorHistory = useHistory(buildInitialState(block.wheelConfig), handleHistoryChange);

  // Dynamic wheel sizing — shrinks as sheet grows, matching Flutter behavior
  const bottomControlsHeight = 96;
  const grabbingHeight = 30;
  const midSnap = 460;
  const spacerProgress = isMobile ? Math.min(sheetHeight / midSnap, 1) : 0;
  const wheelPadding = 140 - 110 * spacerProgress;
  const availableForWheel = isMobile
    ? screenHeight - Math.max(sheetHeight, bottomControlsHeight)
    : screenHeight - 100;
  const maxWheelSize = Math.min(availableForWheel - wheelPadding, effectiveWheelSize);
  const clampedWheelSize = Math.max(80, Math.min(maxWheelSize, effectiveWheelSize));
  const dynamicScale = clampedWheelSize / idealWheelSize;
  // Wheel fades out when sheet goes past mid snap toward full height
  const upperSnap = screenHeight - 80;
  const wheelOpacity = isMobile && sheetHeight > midSnap
    ? Math.max(0, 1 - 2 * (sheetHeight - midSnap) / (upperSnap - midSnap))
    : 1;

  return (
    <div style={{
      display: 'flex',
      height: '100dvh',
      backgroundColor: isEditMode && !isMobile ? '#FFFFFF' : backgroundColor,
      overflow: 'hidden',
    }}>
      {/* Desktop sidebar editor */}
      {isEditMode && !isMobile && (
        <div style={{
          width: 400,
          borderRight: '1.5px solid #E4E4E7',
          backgroundColor: '#FFFFFF',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', padding: '8px 8px 0 8px' }}>
            <button onClick={() => navigate(-1)} style={{ padding: 8 }}>
              <ArrowLeft size={24} />
            </button>
            <div style={{ flex: 1, marginLeft: 4 }}>
              <h2 style={{ fontSize: 22, fontWeight: 700, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {activeConfig.name}
              </h2>
            </div>
          </div>
          <div style={{ flex: 1, overflow: 'hidden' }}>
            <WheelEditor
              key={currentConfig.id}
              initialConfig={currentConfig}
              history={editorHistory}
              onPreview={handleWheelPreview}
            />
          </div>
        </div>
      )}

      {/* Wheel + sheet area */}
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        backgroundColor,
        overflow: 'hidden',
      }}>
        {/* App bar — fades out as sheet rises */}
        <div style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          display: 'flex',
          justifyContent: 'space-between',
          padding: '12px 8px',
          zIndex: 10,
          opacity: isMobile ? Math.max(0, 1 - sheetHeight / midSnap) : 1,
          height: isMobile ? 54 * Math.max(0, 1 - sheetHeight / midSnap) : 54,
          overflow: 'hidden',
          transition: sheetHeight === 0 ? 'opacity 0.3s, height 0.3s' : 'none',
        }}>
          <button onClick={() => navigate(-1)} style={{ padding: 8 }}>
            <ArrowLeft size={32} color="#FFFFFF" />
          </button>
          <div style={{ display: 'flex', gap: 4 }}>
            {isPlayMode && (
              <button onClick={() => setIsPlayMode(false)} style={{ padding: 8 }}>
                <X size={32} color="#FFFFFF" />
              </button>
            )}
            <button onClick={() => setShowGearMenu(true)} style={{ padding: 8 }}>
              <Settings size={32} color="#FFFFFF" />
            </button>
            {!isEditMode && !isPlayMode && (
              <button onClick={() => { setIsEditMode(true); setShowEditor(true); }} style={{ padding: 8 }}>
                <Pencil size={32} color="#FFFFFF" />
              </button>
            )}
          </div>
        </div>

        {/* Game container — height shrinks as sheet grows */}
        <div style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: isMobile ? sheetHeight : bottomControlsHeight,
          paddingTop: isMobile ? 16 * spacerProgress : 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          opacity: wheelOpacity,
        }}>
          {/* Top spacer — centers wheel */}
          <div style={{ flex: 1 }} />
          <SpinningWheel
            ref={wheelRef}
            items={activeConfig.items}
            onFinished={onWheelFinished}
            size={clampedWheelSize}
            textSizeMultiplier={activeConfig.textSize * dynamicScale}
            headerTextSizeMultiplier={activeConfig.headerTextSize * dynamicScale}
            imageSize={activeConfig.imageSize * dynamicScale}
            cornerRadius={activeConfig.cornerRadius * dynamicScale}
            innerCornerStyle={activeConfig.innerCornerStyle}
            centerInset={activeConfig.centerInset * dynamicScale}
            strokeWidth={activeConfig.strokeWidth * dynamicScale}
            showBackgroundCircle={activeConfig.showBackgroundCircle}
            centerMarkerSize={activeConfig.centerMarkerSize * dynamicScale}
            spinIntensity={spinIntensity}
            isRandomIntensity={isRandomIntensity}
            headerTextColor={textColor}
            overlayColor={overlayColor}
            showWinAnimation={showWinAnimation}
            headerOpacity={isMobile ? Math.max(0, 1 - spacerProgress) : 1}
            headerSizeProgress={isMobile ? Math.max(0, 1 - spacerProgress) : 1}
          />
          {/* Bottom spacer — centers wheel */}
          <div style={{ flex: 1 }} />
          {/* Spin button pinned to bottom — fades & collapses when sheet opens or play mode */}
          <div style={{
            width: '100%',
            padding: '0 20px',
            flexShrink: 0,
            opacity: Math.max(0, 1 - spacerProgress),
            height: 64 * Math.max(0, 1 - spacerProgress),
            marginBottom: 12 * Math.max(0, 1 - spacerProgress),
            overflow: 'hidden',
            transition: 'opacity 0.3s, height 0.3s, margin-bottom 0.3s',
          }}>
            <PushDownButton color={PRIMARY} onTap={() => wheelRef.current?.spin()}>
              <span style={{ color: '#FFF', fontSize: 24, fontWeight: 800, letterSpacing: 2 }}>SPIN</span>
            </PushDownButton>
          </div>
          {/* Bottom controls container */}
          <div style={{
            flexShrink: 0,
            width: '100%',
            height: isPlayMode ? 0 : bottomControlsHeight + 100,
            opacity: isPlayMode ? 0 : 1,
            backgroundColor: 'red',
            overflow: 'hidden',
            transition: 'height 0.3s ease, opacity 0.3s ease',
            position: 'relative',
          }}>
            {/* Play button */}
            <button
              onClick={() => setIsPlayMode(true)}
              style={{
                position: 'absolute',
                top: 12,
                left: 16,
                padding: 8,
                background: 'none',
                border: 'none',
                cursor: 'pointer',
              }}
            >
              <Play size={28} color="#FFFFFF" fill="#FFFFFF" />
            </button>
            {/* Undo / Redo */}
            <div style={{
              position: 'absolute',
              top: 12,
              right: 16,
              display: 'flex',
              gap: 6,
            }}>
              <button
                onClick={editorHistory.undo}
                disabled={!editorHistory.canUndo}
                style={{
                  width: 36, height: 36,
                  borderRadius: 50,
                  backgroundColor: 'rgba(255,255,255,0.15)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: editorHistory.canUndo ? 'pointer' : 'default',
                  opacity: editorHistory.canUndo ? 1 : 0.35,
                  border: 'none',
                  transition: 'opacity 0.15s',
                }}
              >
                <Undo2 size={18} color="#FFFFFF" />
              </button>
              <button
                onClick={editorHistory.redo}
                disabled={!editorHistory.canRedo}
                style={{
                  width: 36, height: 36,
                  borderRadius: 50,
                  backgroundColor: 'rgba(255,255,255,0.15)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: editorHistory.canRedo ? 'pointer' : 'default',
                  opacity: editorHistory.canRedo ? 1 : 0.35,
                  border: 'none',
                  transition: 'opacity 0.15s',
                }}
              >
                <Redo2 size={18} color="#FFFFFF" />
              </button>
            </div>
          </div>
        </div>

        {/* Mobile editor snapping sheet — sits above bottom controls */}
        {isEditMode && isMobile && (
          <SnappingSheet
            visible={showEditor}
            snapPositions={[0, 460, screenHeight - 80]}
            initialSnap={1}
            bottomOffset={0}
            onCollapsed={() => { setShowEditor(false); setIsEditMode(false); setSheetHeight(0); }}
            onHeightChange={setSheetHeight}
          >
            <WheelEditor
              key={currentConfig.id}
              initialConfig={currentConfig}
              history={editorHistory}
              onPreview={handleWheelPreview}
              onClose={() => { setShowEditor(false); setIsEditMode(false); setSheetHeight(0); }}
            />
          </SnappingSheet>
        )}

      </div>

      {/* Gear menu */}
      {showGearMenu && (
        <DraggableSheet onClose={() => setShowGearMenu(false)}>
          <div style={{ padding: '0 24px 32px' }}>
            <h3 style={{ fontSize: 20, fontWeight: 800, textAlign: 'center', margin: '0 0 24px' }}>Spin Settings</h3>

            <ToggleRow
              label="Random Intensity"
              icon={<Shuffle size={22} />}
              value={isRandomIntensity}
              onChange={setIsRandomIntensity}
            />
            <div style={{ height: 12 }} />

            {!isRandomIntensity && (
              <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12, gap: 8 }}>
                <span style={{ width: 100, fontWeight: 600, fontSize: 14, color: withAlpha(ON_SURFACE, 0.6) }}>Intensity</span>
                <input
                  type="range"
                  min={0} max={1} step={0.05}
                  value={spinIntensity}
                  onChange={e => setSpinIntensity(parseFloat(e.target.value))}
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
              onChange={setShowWinAnimation}
            />
          </div>
        </DraggableSheet>
      )}
    </div>
  );
}

function ToggleRow({ label, icon, value, onChange }: {
  label: string;
  icon: React.ReactNode;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div
      onClick={() => onChange(!value)}
      style={{
        display: 'flex',
        alignItems: 'center',
        padding: '14px 16px',
        borderRadius: 14,
        backgroundColor: value ? withAlpha(PRIMARY, 0.12) : '#F4F4F5',
        border: `1.5px solid ${value ? PRIMARY : '#D4D4D8'}`,
        cursor: 'pointer',
        transition: 'all 0.18s',
      }}
    >
      <div style={{ color: value ? '#0EA5E9' : withAlpha(ON_SURFACE, 0.45) }}>{icon}</div>
      <span style={{
        flex: 1,
        marginLeft: 12,
        fontWeight: 700,
        fontSize: 15,
        color: value ? ON_SURFACE : withAlpha(ON_SURFACE, 0.5),
      }}>
        {label}
      </span>
      {/* Toggle switch */}
      <div style={{
        width: 44, height: 26,
        borderRadius: 13,
        backgroundColor: value ? PRIMARY : '#D4D4D8',
        display: 'flex',
        alignItems: 'center',
        padding: 2,
        justifyContent: value ? 'flex-end' : 'flex-start',
        transition: 'all 0.18s',
      }}>
        <div style={{
          width: 22, height: 22,
          borderRadius: '50%',
          backgroundColor: '#FFFFFF',
        }} />
      </div>
    </div>
  );
}
