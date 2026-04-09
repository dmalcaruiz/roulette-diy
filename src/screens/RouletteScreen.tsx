import { useState, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Block, WheelConfig } from '../models/types';
import SpinningWheel, { SpinningWheelHandle } from '../components/SpinningWheel';
import WheelEditor from '../components/WheelEditor';
import { PushDownButton } from '../components/PushDownButton';
import { withAlpha } from '../utils/colorUtils';
import { ON_SURFACE, PRIMARY } from '../utils/constants';
import { ArrowLeft, Settings, Pencil, RotateCcw, Shuffle, Sparkles, Palette } from 'lucide-react';
import DraggableSheet from '../components/DraggableSheet';
import SnappingSheet from '../components/SnappingSheet';

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

  // Dynamic wheel sizing — shrinks as sheet grows, matching Flutter behavior
  const bottomControlsHeight = 96;
  const grabbingHeight = 30;
  const midSnap = 460;
  const spacerProgress = isMobile ? Math.min(sheetHeight / midSnap, 1) : 0;
  const wheelPadding = 140 - 80 * spacerProgress;
  const availableForWheel = isMobile
    ? screenHeight - sheetHeight - grabbingHeight - bottomControlsHeight + 45
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
            <button onClick={() => setShowGearMenu(true)} style={{ padding: 8 }}>
              <Settings size={32} color="#FFFFFF" />
            </button>
            {!isEditMode && (
              <button onClick={() => { setIsEditMode(true); setShowEditor(true); }} style={{ padding: 8 }}>
                <Pencil size={32} color="#FFFFFF" />
              </button>
            )}
          </div>
        </div>

        {/* Wheel container — height shrinks as sheet grows */}
        <div style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: isMobile ? sheetHeight + bottomControlsHeight + grabbingHeight : bottomControlsHeight,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          opacity: wheelOpacity,
        }}>
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
          />
        </div>

        {/* Mobile editor snapping sheet — sits above bottom controls */}
        {isEditMode && isMobile && (
          <SnappingSheet
            visible={showEditor}
            snapPositions={[0, 460, screenHeight - 80]}
            initialSnap={1}
            bottomOffset={bottomControlsHeight}
            onCollapsed={() => { setShowEditor(false); setSheetHeight(0); }}
            onHeightChange={setSheetHeight}
          >
            <WheelEditor
              key={currentConfig.id}
              initialConfig={currentConfig}
              onPreview={handleWheelPreview}
              onClose={() => { setShowEditor(false); setSheetHeight(0); }}
            />
          </SnappingSheet>
        )}

        {/* Bottom controls — always at screen bottom */}
        <div style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          backgroundColor: '#FFFFFF',
          borderRadius: '36px 36px 0 0',
          border: '1.5px solid #E4E4E7',
          borderBottom: 'none',
          padding: '18px 20px 20px',
          zIndex: 60,
        }}>
          {isEditMode ? (
            <div style={{ display: 'flex', gap: 10 }}>
              <PushDownButton
                color="#AE01CB"
                onTap={() => wheelRef.current?.reset()}
                style={{ width: 69 }}
              >
                <RotateCcw size={28} color="#FFFFFF" />
              </PushDownButton>
              <div style={{ flex: 1 }}>
                <PushDownButton color={PRIMARY} onTap={() => wheelRef.current?.spin()}>
                  <span style={{ color: '#FFF', fontSize: 24, fontWeight: 800, letterSpacing: 2 }}>SPIN</span>
                </PushDownButton>
              </div>
              {isMobile && (
                <PushDownButton
                  color={ON_SURFACE}
                  onTap={() => setShowEditor(true)}
                  style={{ width: 69 }}
                >
                  <Pencil size={28} color="#FFFFFF" />
                </PushDownButton>
              )}
            </div>
          ) : (
            <PushDownButton color={PRIMARY} onTap={() => wheelRef.current?.spin()}>
              <span style={{ color: '#FFF', fontSize: 24, fontWeight: 800, letterSpacing: 2 }}>SPIN</span>
            </PushDownButton>
          )}
        </div>
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
