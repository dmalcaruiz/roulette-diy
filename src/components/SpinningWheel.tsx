import { useRef, useEffect, useLayoutEffect, useCallback, useState, forwardRef, useImperativeHandle } from 'react';
import { WheelItem } from '../models/types';
import { paintWheel, WheelPainterConfig } from './WheelCanvas';

export interface SpinningWheelProps {
  items: WheelItem[];
  onFinished: (index: number) => void;
  size?: number;
  textSizeMultiplier?: number;
  headerTextSizeMultiplier?: number;
  imageSize?: number;
  cornerRadius?: number;
  innerCornerStyle?: 'none' | 'rounded' | 'circular' | 'straight';
  centerInset?: number;
  strokeWidth?: number;
  showBackgroundCircle?: boolean;
  centerMarkerSize?: number;
  spinIntensity?: number;
  isRandomIntensity?: boolean;
  headerTextColor?: string;
  overlayColor?: string;
  showWinAnimation?: boolean;
  headerOpacity?: number;
  headerSizeProgress?: number;
}

export interface SpinningWheelHandle {
  spin: () => void;
  reset: () => void;
  isSpinning: boolean;
}

const SpinningWheel = forwardRef<SpinningWheelHandle, SpinningWheelProps>((props, ref) => {
  const {
    items,
    onFinished,
    size = 300,
    textSizeMultiplier = 1,
    headerTextSizeMultiplier = 1,
    imageSize = 60,
    cornerRadius = 8,
    innerCornerStyle = 'none',
    centerInset = 50,
    strokeWidth = 3,
    showBackgroundCircle = true,
    centerMarkerSize = 200,
    spinIntensity = 0.5,
    isRandomIntensity = true,
    headerTextColor = '#FFFFFF',
    overlayColor = '#000000',
    showWinAnimation = true,
    headerOpacity = 1,
    headerSizeProgress = 1,
  } = props;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const rotationRef = useRef(0);
  const isSpinningRef = useRef(false);
  const [isSpinning, setIsSpinning] = useState(false);
  const [currentSegment, setCurrentSegment] = useState('');
  const [segmentHeaderOpacity, setSegmentHeaderOpacity] = useState(1);

  // Overlay animation state
  const overlayOpacityRef = useRef(0);
  const winningIndexRef = useRef(-1);

  // Audio pool
  const audioPoolRef = useRef<HTMLAudioElement[]>([]);
  const audioIndexRef = useRef(0);

  // Initialize audio pool
  useEffect(() => {
    const pool: HTMLAudioElement[] = [];
    for (let i = 0; i < 20; i++) {
      const audio = new Audio('/audio/click.mp3');
      audio.preload = 'auto';
      pool.push(audio);
    }
    audioPoolRef.current = pool;
    return () => {
      pool.forEach(a => { a.pause(); a.src = ''; });
    };
  }, []);

  const playClick = useCallback(() => {
    if (audioPoolRef.current.length === 0) return;
    try {
      const player = audioPoolRef.current[audioIndexRef.current];
      audioIndexRef.current = (audioIndexRef.current + 1) % audioPoolRef.current.length;
      player.currentTime = 0;
      player.play().catch(() => {});
    } catch {}
  }, []);

  const updateCurrentSegment = useCallback(() => {
    const totalWeight = items.reduce((s, item) => s + item.weight, 0);
    const currentAngle = (2 * Math.PI - (rotationRef.current % (2 * Math.PI)) - Math.PI / 2 + 4 * Math.PI) % (2 * Math.PI);
    let accumulated = 0;
    for (const item of items) {
      accumulated += item.weight;
      const segmentEnd = (accumulated / totalWeight) * 2 * Math.PI;
      if (currentAngle <= segmentEnd) {
        setCurrentSegment(item.text);
        break;
      }
    }
  }, [items]);

  const getWinningIndex = useCallback(() => {
    const totalWeight = items.reduce((s, item) => s + item.weight, 0);
    const finalAngle = (2 * Math.PI - (rotationRef.current % (2 * Math.PI)) - Math.PI / 2 + 4 * Math.PI) % (2 * Math.PI);
    let accumulated = 0;
    for (let i = 0; i < items.length; i++) {
      accumulated += items[i].weight;
      const segmentEnd = (accumulated / totalWeight) * 2 * Math.PI;
      if (finalAngle <= segmentEnd) return i;
    }
    return items.length - 1;
  }, [items]);

  const getRandomWeightedIndex = useCallback(() => {
    const totalWeight = items.reduce((s, item) => s + item.weight, 0);
    let random = Math.random() * totalWeight;
    let accumulated = 0;
    for (let i = 0; i < items.length; i++) {
      accumulated += items[i].weight;
      if (random < accumulated) return i;
    }
    return items.length - 1;
  }, [items]);

  // Paint function
  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const displaySize = size;

    if (canvas.width !== displaySize * dpr || canvas.height !== displaySize * dpr) {
      canvas.width = displaySize * dpr;
      canvas.height = displaySize * dpr;
      ctx.scale(dpr, dpr);
    }

    const fontSize = (items.length >= 16 ? 24 : displaySize / 16) * textSizeMultiplier;

    const config: WheelPainterConfig = {
      items,
      rotation: rotationRef.current,
      fontSize,
      cornerRadius,
      strokeWidth,
      showBackgroundCircle,
      imageSize,
      overlayColor,
      textVerticalOffset: displaySize / 700 * 2,
      innerCornerStyle,
      centerInset,
      overlayOpacity: overlayOpacityRef.current,
      winningIndex: winningIndexRef.current,
      loadingAngle: 0,
      transition: 1,
    };

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    paintWheel(ctx, displaySize, displaySize, config);
  }, [items, size, textSizeMultiplier, cornerRadius, strokeWidth,
      showBackgroundCircle, imageSize, overlayColor, innerCornerStyle, centerInset]);

  // Initial paint and repaint on prop changes — useLayoutEffect (not
  // useEffect) so the canvas is drawn synchronously after layout BEFORE the
  // browser paints the frame. With useEffect there's a one-frame gap where
  // the canvas exists but is unpainted, which on a remount (e.g. tapping +
  // to add a new wheel) shows up as a white flash.
  useLayoutEffect(() => {
    paint();
  }, [paint]);

  // Update segment on mount
  useEffect(() => {
    updateCurrentSegment();
  }, [updateCurrentSegment]);

  // Easing function (easeOutCubic)
  const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
  const easeInOut = (t: number) => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

  const spin = useCallback(() => {
    if (isSpinningRef.current) return;

    isSpinningRef.current = true;
    setIsSpinning(true);
    setSegmentHeaderOpacity(1);

    const winningIndex = getRandomWeightedIndex();
    const totalWeight = items.reduce((s, item) => s + item.weight, 0);
    const arcSize = (2 * Math.PI) / totalWeight;

    let effectiveIntensity: number;
    if (isRandomIntensity) {
      effectiveIntensity = Math.random();
    } else {
      const offset = (Math.random() - 0.5) * 0.06;
      effectiveIntensity = Math.max(0, Math.min(1, spinIntensity + offset));
    }

    // Pullback
    const basePullback = isRandomIntensity
      ? (10 + effectiveIntensity * 35) * (Math.PI / 180)
      : (5 + effectiveIntensity * 45) * (Math.PI / 180);
    const pullbackVariation = isRandomIntensity
      ? (Math.random() - 0.5) * 10 * (Math.PI / 180)
      : (Math.random() - 0.5) * 2 * (Math.PI / 180);
    const pullbackAmount = basePullback + pullbackVariation;

    // Rotations
    const baseRotations = isRandomIntensity
      ? 1 + Math.floor(effectiveIntensity * 4)
      : 1 + Math.floor(effectiveIntensity * 6);
    const totalRotations = isRandomIntensity
      ? baseRotations + Math.random()
      : baseRotations + Math.random() * 0.2;

    // Winning angle
    let winningAngle = 0;
    const winningSegmentSize = arcSize * items[winningIndex].weight;
    for (let i = 0; i <= winningIndex; i++) {
      winningAngle += arcSize * items[i].weight;
    }
    const offset = Math.random() * winningSegmentSize;
    const finalRotation = totalRotations * 2 * Math.PI + (2 * Math.PI - winningAngle + offset);

    // Duration
    const baseDuration = isRandomIntensity
      ? 2000 + effectiveIntensity * 4000
      : 1500 + effectiveIntensity * 5500;
    const durationOffset = isRandomIntensity
      ? Math.random() * 500 - 250
      : Math.random() * 100 - 50;
    const mainDuration = baseDuration + durationOffset;

    const pullbackDuration = isRandomIntensity
      ? 200 + effectiveIntensity * 100
      : 150 + effectiveIntensity * 200;

    const startRotation = rotationRef.current;

    // Phase 1: Pullback
    const pullbackStart = performance.now();

    // Pre-schedule sounds
    const scheduledSounds: number[] = [];
    {
      const samples = 200;
      let lastSegment: string | null = null;
      const tw = items.reduce((s, item) => s + item.weight, 0);
      for (let i = 0; i <= samples; i++) {
        const progress = i / samples;
        const eased = easeOutCubic(progress);
        const rot = (startRotation - pullbackAmount) + eased * (pullbackAmount + finalRotation);
        const angle = (2 * Math.PI - (rot % (2 * Math.PI)) - Math.PI / 2 + 4 * Math.PI) % (2 * Math.PI);
        let acc = 0;
        let seg: string | null = null;
        for (const item of items) {
          acc += item.weight;
          if (angle <= (acc / tw) * 2 * Math.PI) { seg = item.text; break; }
        }
        if (seg && seg !== lastSegment && lastSegment !== null) {
          const delay = pullbackDuration + progress * mainDuration;
          scheduledSounds.push(window.setTimeout(playClick, delay));
        }
        lastSegment = seg;
      }
    }

    const animatePullback = (now: number) => {
      const elapsed = now - pullbackStart;
      const t = Math.min(1, elapsed / pullbackDuration);
      const eased = easeInOut(t);
      rotationRef.current = startRotation - pullbackAmount * eased;
      updateCurrentSegment();
      paint();

      if (t < 1) {
        animRef.current = requestAnimationFrame(animatePullback);
      } else {
        // Phase 2: Main spin
        const spinStart = performance.now();
        const spinStartRotation = rotationRef.current;
        const spinTotalRotation = pullbackAmount + finalRotation;

        const animateMainSpin = (now: number) => {
          const elapsed = now - spinStart;
          const t = Math.min(1, elapsed / mainDuration);
          const eased = easeOutCubic(t);
          rotationRef.current = spinStartRotation + spinTotalRotation * eased;
          updateCurrentSegment();
          paint();

          if (t < 1) {
            animRef.current = requestAnimationFrame(animateMainSpin);
          } else {
            // Spin complete
            isSpinningRef.current = false;
            setIsSpinning(false);
            const idx = getWinningIndex();
            onFinished(idx);

            // Clear scheduled sounds
            scheduledSounds.forEach(clearTimeout);

            if (showWinAnimation) {
              // Overlay animation
              winningIndexRef.current = idx;
              const overlayStart = performance.now();
              const overlayDuration = 400;

              const animateOverlayIn = (now: number) => {
                const t = Math.min(1, (now - overlayStart) / overlayDuration);
                overlayOpacityRef.current = easeInOut(t);
                paint();
                if (t < 1) {
                  animRef.current = requestAnimationFrame(animateOverlayIn);
                } else {
                  // Hold for 2 seconds, then fade out
                  setTimeout(() => {
                    const fadeStart = performance.now();
                    const animateOverlayOut = (now: number) => {
                      const t = Math.min(1, (now - fadeStart) / overlayDuration);
                      overlayOpacityRef.current = 1 - easeInOut(t);
                      paint();
                      if (t < 1) {
                        animRef.current = requestAnimationFrame(animateOverlayOut);
                      } else {
                        overlayOpacityRef.current = 0;
                        winningIndexRef.current = -1;
                        paint();
                      }
                    };
                    animRef.current = requestAnimationFrame(animateOverlayOut);
                  }, 2000);
                }
              };
              animRef.current = requestAnimationFrame(animateOverlayIn);
            }
          }
        };
        animRef.current = requestAnimationFrame(animateMainSpin);
      }
    };

    animRef.current = requestAnimationFrame(animatePullback);
  }, [items, spinIntensity, isRandomIntensity, showWinAnimation, paint,
      updateCurrentSegment, getWinningIndex, getRandomWeightedIndex, onFinished, playClick]);

  const reset = useCallback(() => {
    cancelAnimationFrame(animRef.current);
    isSpinningRef.current = false;
    setIsSpinning(false);
    setSegmentHeaderOpacity(0);

    overlayOpacityRef.current = 0;
    winningIndexRef.current = -1;

    const current = rotationRef.current;
    const fullRotation = 2 * Math.PI;
    const numRotations = Math.round(current / fullRotation);
    const closest = numRotations * fullRotation;

    if (Math.abs(current - closest) < 0.01) {
      paint();
      return;
    }

    // Animate to closest full rotation
    const startTime = performance.now();
    const duration = 500;
    const startRot = current;
    const endRot = closest;

    const animate = (now: number) => {
      const t = Math.min(1, (now - startTime) / duration);
      const eased = easeInOut(t);
      rotationRef.current = startRot + (endRot - startRot) * eased;
      paint();
      if (t < 1) {
        animRef.current = requestAnimationFrame(animate);
      }
    };
    animRef.current = requestAnimationFrame(animate);
  }, [paint]);

  useImperativeHandle(ref, () => ({
    spin,
    reset,
    get isSpinning() { return isSpinningRef.current; },
  }), [spin, reset]);

  // Cleanup animation on unmount
  useEffect(() => {
    return () => cancelAnimationFrame(animRef.current);
  }, []);

  const headerFontSize = 56 * headerTextSizeMultiplier;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      {/* Segment header — in flow above the canvas so the (header + canvas)
          group acts as a unit when the parent centers this component. */}
      <div style={{
        opacity: headerOpacity,
        transform: `scale(${headerSizeProgress})`,
        transformOrigin: 'center bottom',
        height: (headerFontSize + 16) * headerSizeProgress,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        willChange: 'transform, height, opacity',
      }}>
        <div style={{
          opacity: segmentHeaderOpacity,
          transition: 'opacity 0.3s ease',
          fontSize: headerFontSize,
          fontWeight: 700,
          color: headerTextColor,
          whiteSpace: 'nowrap',
        }}>
          {currentSegment}
        </div>
      </div>

      <div style={{ height: 16 * headerSizeProgress }} />

      {/* Wheel + marker */}
      <div style={{
        position: 'relative',
        width: size,
        height: size,
        cursor: 'pointer',
      }}
        onClick={spin}
      >
        <canvas
          ref={canvasRef}
          style={{ width: size, height: size, display: 'block' }}
        />
        {/* Center SVG Marker */}
        <div style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: centerMarkerSize,
          height: centerMarkerSize,
          pointerEvents: 'none',
        }}>
          {/* Shadow */}
          <img
            src="/images/Marker.svg"
            alt=""
            style={{
              position: 'absolute',
              width: '100%',
              height: '100%',
              filter: 'blur(4px) brightness(0)',
              opacity: 0.4,
              top: '2%',
              left: '1%',
            }}
          />
          {/* Marker */}
          <img
            src="/images/Marker.svg"
            alt="marker"
            style={{
              position: 'relative',
              width: '100%',
              height: '100%',
            }}
          />
        </div>
      </div>

      <div style={{ height: 16 }} />
    </div>
  );
});

SpinningWheel.displayName = 'SpinningWheel';
export default SpinningWheel;
