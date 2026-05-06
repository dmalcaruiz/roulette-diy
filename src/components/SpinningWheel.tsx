import { useRef, useEffect, useLayoutEffect, useCallback, useState, forwardRef, useImperativeHandle } from 'react';

// WebAudio click playback. HTMLAudioElement was visibly blocking the rAF
// loop on each spin tick (every play() call did a few ms of synchronous
// engine work to reset currentTime + start playback), causing dropped
// frames during fast spins. The WebAudio path decodes the click waveform
// once into an AudioBuffer at module load, then each click just spins up
// a cheap AudioBufferSourceNode — start() is sub-millisecond and doesn't
// touch the main thread budget meaningfully, so it stays inline in the
// rAF without harming frame pacing.
let sharedAudioCtx: AudioContext | null = null;
let sharedClickBuffer: AudioBuffer | null = null;
let clickLoadPromise: Promise<void> | null = null;

function getAudioCtx(): AudioContext | null {
  if (sharedAudioCtx) return sharedAudioCtx;
  // Older Safari needs the webkit prefix.
  const Ctor = (window.AudioContext
    || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
  if (!Ctor) return null;
  sharedAudioCtx = new Ctor();
  return sharedAudioCtx;
}

function ensureClickBuffer(): Promise<void> {
  if (sharedClickBuffer) return Promise.resolve();
  if (clickLoadPromise) return clickLoadPromise;
  const ctx = getAudioCtx();
  if (!ctx) return Promise.resolve();
  clickLoadPromise = (async () => {
    try {
      const res = await fetch('/audio/click.mp3');
      const buf = await res.arrayBuffer();
      sharedClickBuffer = await ctx.decodeAudioData(buf);
    } catch {
      // If load fails, leave the buffer null — click() becomes a no-op.
    }
  })();
  return clickLoadPromise;
}

// Kick off the load eagerly so by the time the user spins, the buffer is
// decoded and ready.
ensureClickBuffer();

// AudioContext starts suspended in every modern browser and only
// transitions to 'running' after a user gesture calls resume(). The
// resume itself is async, so if we wait until spin() to call it, the
// first spin's `ctx.state === 'running'` check fails and every click
// for that spin gets skipped — silent first spin, working subsequent
// ones (the symptom the user reported).
//
// Bootstrap once at module load: capture the *very first* pointer/touch/
// key gesture anywhere on the page and resume the context then. By the
// time the user finds the spin button and taps it, the context is
// already running and scheduling works on the first try.
if (typeof document !== 'undefined') {
  const unlock = () => {
    const ctx = getAudioCtx();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
    // Also nudge buffer load — fetch may have failed silently if the
    // module-load attempt ran before the document was ready.
    ensureClickBuffer();
    document.removeEventListener('pointerdown', unlock, true);
    document.removeEventListener('touchstart', unlock, true);
    document.removeEventListener('keydown', unlock, true);
  };
  document.addEventListener('pointerdown', unlock, true);
  document.addEventListener('touchstart', unlock, true);
  document.addEventListener('keydown', unlock, true);
}

function playClickInline(): void {
  const ctx = sharedAudioCtx;
  const buf = sharedClickBuffer;
  if (!ctx || !buf) return;
  // AudioContext starts suspended on most browsers until a user gesture
  // resumes it; the spin button tap qualifies, so by the time we're ticking
  // through segments the context is running.
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start(0);
}
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
  // Win-overlay rAF lives in its own slot, separate from the spin /
  // decay loop's animRef. This way `cancelInFlight()` (which fires when
  // the user grabs the wheel for a new gesture) can cancel the spin
  // animation without ever interrupting the post-spin win flash —
  // grabbing the wheel mid-flash now no longer leaves the overlay
  // stuck at partial opacity.
  const winAnimRef = useRef<number>(0);
  const winHoldTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // (playClickInline is invoked directly from spin via WebAudio's
  // sample-accurate scheduler now — no per-frame click trigger needed.)
  // Tracks every scheduled-but-not-yet-fired click source for the active
  // spin so reset() can stop them mid-flight if the user interrupts.
  const scheduledSourcesRef = useRef<AudioBufferSourceNode[]>([]);

  // Pure helper — returns the segment text under the marker for a given
  // rotation, no side effects. Lets the rAF loop diff against the previous
  // frame and only call setState / playClick on real segment crossings,
  // instead of hammering setCurrentSegment 60×/sec.
  const segmentAtRotation = useCallback((rotation: number): string => {
    const totalWeight = items.reduce((s, item) => s + item.weight, 0);
    const currentAngle = (2 * Math.PI - (rotation % (2 * Math.PI)) - Math.PI / 2 + 4 * Math.PI) % (2 * Math.PI);
    let accumulated = 0;
    for (const item of items) {
      accumulated += item.weight;
      const segmentEnd = (accumulated / totalWeight) * 2 * Math.PI;
      if (currentAngle <= segmentEnd) return item.text;
    }
    return items[items.length - 1]?.text ?? '';
  }, [items]);

  // Tracks the segment shown last frame so the rAF loop can detect a real
  // crossing and fire setState + playClick exactly once per crossing —
  // sound stays locked to the rendered rotation regardless of frame jitter.
  const lastRenderedSegmentRef = useRef<string>('');

  const updateCurrentSegment = useCallback(() => {
    const seg = segmentAtRotation(rotationRef.current);
    if (seg !== lastRenderedSegmentRef.current) {
      lastRenderedSegmentRef.current = seg;
      setCurrentSegment(seg);
    }
  }, [segmentAtRotation]);

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

  // Cancel any in-flight spin/decay animation + scheduled audio so a new
  // drag starts from a clean slate. Deliberately does NOT touch the win-
  // overlay animation (winAnimRef / winHoldTimerRef) — once a win flash
  // begins it must run to completion regardless of subsequent gestures.
  const cancelInFlight = useCallback(() => {
    cancelAnimationFrame(animRef.current);
    for (const s of scheduledSourcesRef.current) {
      try { s.stop(); } catch {}
    }
    scheduledSourcesRef.current = [];
  }, []);

  // Win-overlay flash. Lives in its own animation slot so user gestures
  // (drag-to-spin, tap-to-spin, anything that calls cancelInFlight) can
  // never stop it mid-fade. Cancels only a *previous* win flash that's
  // still in flight, so a fresh win starts cleanly.
  const playWinOverlay = useCallback((idx: number) => {
    cancelAnimationFrame(winAnimRef.current);
    if (winHoldTimerRef.current) {
      clearTimeout(winHoldTimerRef.current);
      winHoldTimerRef.current = null;
    }
    winningIndexRef.current = idx;
    const overlayDuration = 400;
    const overlayStart = performance.now();
    const animateOverlayIn = (t0: number) => {
      const t = Math.min(1, (t0 - overlayStart) / overlayDuration);
      overlayOpacityRef.current = easeInOut(t);
      paint();
      if (t < 1) {
        winAnimRef.current = requestAnimationFrame(animateOverlayIn);
      } else {
        winHoldTimerRef.current = setTimeout(() => {
          winHoldTimerRef.current = null;
          const fadeStart = performance.now();
          const animateOverlayOut = (t1: number) => {
            const t = Math.min(1, (t1 - fadeStart) / overlayDuration);
            overlayOpacityRef.current = 1 - easeInOut(t);
            paint();
            if (t < 1) {
              winAnimRef.current = requestAnimationFrame(animateOverlayOut);
            } else {
              overlayOpacityRef.current = 0;
              winningIndexRef.current = -1;
              paint();
            }
          };
          winAnimRef.current = requestAnimationFrame(animateOverlayOut);
        }, 2000);
      }
    };
    winAnimRef.current = requestAnimationFrame(animateOverlayIn);
  }, [paint]);

  const spin = useCallback(() => {
    if (isSpinningRef.current) return;

    // The spin click is a user gesture — resume the AudioContext now so
    // the scheduled clicks below can fire on the audio thread. Also kick
    // off buffer loading if it hasn't completed yet (cheap no-op if
    // already loaded).
    const gestureCtx = getAudioCtx();
    if (gestureCtx && gestureCtx.state === 'suspended') gestureCtx.resume().catch(() => {});
    ensureClickBuffer();

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

    // Rotations — bumped up so the tap-spin feels punchy. More
    // revolutions packed into the same duration = higher peak angular
    // velocity = more dramatic spin.
    const baseRotations = isRandomIntensity
      ? 4 + Math.floor(effectiveIntensity * 7)
      : 4 + Math.floor(effectiveIntensity * 9);
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

    // Pre-schedule every click for the entire spin via WebAudio's
    // sample-accurate scheduler. Each src.start(time) call queues the
    // click on the audio thread to fire at the exact predicted moment
    // the rotation crosses a segment boundary — completely decoupled
    // from rAF jitter, main-thread blocking, or render hitches. The
    // visual updates (paint + setCurrentSegment) still happen in the
    // rAF loop, but audio sync no longer depends on them firing on time.
    // Cancel any sources from a previous spin that haven't fired yet
    // (defensive — spin() bails early if isSpinningRef is set, but a
    // pre-empted reset could leave queued sources alive).
    for (const s of scheduledSourcesRef.current) {
      try { s.stop(); } catch {}
    }
    scheduledSourcesRef.current = [];
    const ctx = sharedAudioCtx;
    const buf = sharedClickBuffer;
    // Capture wall-clock spin start so the schedule can compensate for
    // any delay if the AudioContext is still resuming (edge case: spin
    // tap is the user's first-ever gesture, so resume() and spin() race).
    const scheduleStartPerf = performance.now();

    const doScheduleClicks = () => {
      if (!ctx || !buf) return;
      // If the context took some time to come up, drop any clicks that
      // would have already fired by now and shift the rest so they still
      // align with the visual rotation.
      const resumeDelayMs = performance.now() - scheduleStartPerf;
      const audioBaseTime = ctx.currentTime - resumeDelayMs / 1000;
      const samples = 600;
      const startSeg = segmentAtRotation(startRotation);
      let prevSeg = startSeg;
      for (let i = 1; i <= samples; i++) {
        const progress = i / samples;
        let rot: number;
        let timeOffsetSec: number;
        if (progress < pullbackDuration / (pullbackDuration + mainDuration)) {
          const localT = progress / (pullbackDuration / (pullbackDuration + mainDuration));
          const eased = easeInOut(localT);
          rot = startRotation - pullbackAmount * eased;
          timeOffsetSec = (localT * pullbackDuration) / 1000;
        } else {
          const localT = (progress - pullbackDuration / (pullbackDuration + mainDuration))
                       / (mainDuration / (pullbackDuration + mainDuration));
          const eased = easeOutCubic(localT);
          rot = (startRotation - pullbackAmount) + eased * (pullbackAmount + finalRotation);
          timeOffsetSec = (pullbackDuration + localT * mainDuration) / 1000;
        }
        const seg = segmentAtRotation(rot);
        if (seg !== prevSeg) {
          const scheduledTime = audioBaseTime + timeOffsetSec;
          // Skip clicks whose ideal time has already passed during the
          // resume wait — better to lose a few early ticks than to bunch
          // them all up at currentTime.
          if (scheduledTime > ctx.currentTime - 0.005) {
            const src = ctx.createBufferSource();
            src.buffer = buf;
            src.connect(ctx.destination);
            src.start(Math.max(scheduledTime, ctx.currentTime));
            scheduledSourcesRef.current.push(src);
          }
          prevSeg = seg;
        }
      }
    };

    if (ctx && buf) {
      if (ctx.state === 'running') {
        doScheduleClicks();
      } else {
        // First-ever-gesture-is-spin edge case: resume is in flight from
        // either the global unlock listener or our own gestureCtx.resume()
        // above; chain the schedule onto its completion so we don't miss
        // every click for this spin.
        ctx.resume().then(doScheduleClicks).catch(() => {});
      }
    }

    // Visual segment-header update: still rAF-driven, fires only on real
    // crossings (cheap — no audio engine work, just a setState diff).
    let lastSegment = segmentAtRotation(startRotation);
    lastRenderedSegmentRef.current = lastSegment;
    const onFrameRotation = (newRotation: number) => {
      const seg = segmentAtRotation(newRotation);
      if (seg !== lastSegment) {
        lastSegment = seg;
        lastRenderedSegmentRef.current = seg;
        setCurrentSegment(seg);
      }
    };

    const animatePullback = (now: number) => {
      const elapsed = now - pullbackStart;
      const t = Math.min(1, elapsed / pullbackDuration);
      const eased = easeInOut(t);
      rotationRef.current = startRotation - pullbackAmount * eased;
      onFrameRotation(rotationRef.current);
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
          onFrameRotation(rotationRef.current);
          paint();

          if (t < 1) {
            animRef.current = requestAnimationFrame(animateMainSpin);
          } else {
            // Spin complete
            isSpinningRef.current = false;
            setIsSpinning(false);
            const idx = getWinningIndex();
            onFinished(idx);
            // Win flash runs on its own animation slot — once kicked off
            // here it can't be interrupted by a subsequent drag.
            if (showWinAnimation) playWinOverlay(idx);
          }
        };
        animRef.current = requestAnimationFrame(animateMainSpin);
      }
    };

    animRef.current = requestAnimationFrame(animatePullback);
  }, [items, spinIntensity, isRandomIntensity, showWinAnimation, paint,
      segmentAtRotation, getWinningIndex, getRandomWeightedIndex, onFinished, playWinOverlay]);

  const reset = useCallback(() => {
    cancelAnimationFrame(animRef.current);
    // Stop any scheduled clicks that haven't fired yet — otherwise the
    // wheel snaps to rest visually but ticks keep playing.
    for (const s of scheduledSourcesRef.current) {
      try { s.stop(); } catch {}
    }
    scheduledSourcesRef.current = [];
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

  // ── Drag-to-spin physics ────────────────────────────────────────────
  // Tap on the wheel still calls the deterministic spin() above (with
  // pre-scheduled audio + a guaranteed weighted-random winner). A drag
  // gesture instead hands the wheel to the user: while their finger is
  // down they rotate it directly via Math.atan2 around the wheel center,
  // and on release the wheel continues with momentum + per-frame friction
  // until it decays to rest. Audio clicks during a drag-spin are fired
  // inline (cheap WebAudio) since we can't pre-schedule when we don't
  // know the trajectory ahead of time.
  //
  // The "spin attempt" criterion: release velocity must clear a threshold
  // AND no pointerdown re-grab can interrupt the decay. If both are met,
  // the wheel triggers the same win callback / overlay flash as a regular
  // spin(), but resolves the winner from the *actual* resting rotation
  // (no pre-rolled randomness — what you spin is what you get).
  const dragRef = useRef<{
    pointerId: number;
    startClientPos: { x: number; y: number };
    centerScreen: { x: number; y: number };
    lastPointerAngle: number;
    crossedThreshold: boolean; // true once movement > tap-vs-drag threshold
    samples: { time: number; rotation: number }[]; // for release-velocity calc
    lastRenderedSegment: string;
    carriedVelocity: number; // momentum captured at grab-start (re-grab during decay)
  } | null>(null);
  // True while a momentum-decay is running, so a re-grab can mark the
  // spin as interrupted (no win animation).
  const decayInterruptedRef = useRef(false);
  // Live momentum velocity during the decay loop. Read by handlePointerDown
  // to "borrow" the in-flight speed when the user re-grabs the wheel,
  // letting consecutive flicks accumulate momentum.
  const momentumVelocityRef = useRef(0);

  // Friction per ms: every ms, velocity is multiplied by this. Higher =
  // less friction = wheel coasts longer. 0.9995 gives a very light feel
  // where a peak-velocity flick coasts for ~7-8 seconds before settling.
  const FRICTION_PER_MS = 0.999;
  // Velocity below which decay is considered done. Tuned so the wheel
  // visibly comes to rest rather than crawling.
  const STOP_VELOCITY = 0.0005; // rad/ms
  // Release-velocity threshold above which a drag counts as an intentional
  // spin attempt (and earns the win-overlay flash on natural stop).
  const SPIN_ATTEMPT_VELOCITY = 0.004; // rad/ms — roughly a casual flick
  // Hard cap on accumulated post-release velocity. ~45 clicks/sec on a
  // 12-segment wheel, still inside WebAudio's comfort zone but high
  // enough that consecutive flicks meaningfully build speed before
  // hitting the ceiling.
  const MAX_VELOCITY = 0.024;

  // (cancelInFlight + playWinOverlay are declared before spin() so that
  // spin's useCallback can include playWinOverlay in its deps.)

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button === 2) return;
    // Re-grab during a momentum decay marks the spin as interrupted (the
    // *original* spin attempt no longer counts as a win) AND captures
    // the in-flight angular velocity so it can be added to the new
    // drag's release velocity — that's what makes consecutive flicks
    // build up speed instead of resetting to zero each time.
    decayInterruptedRef.current = isSpinningRef.current;
    const carried = isSpinningRef.current ? momentumVelocityRef.current : 0;
    cancelInFlight();
    momentumVelocityRef.current = 0;
    isSpinningRef.current = false;
    // The capture target receives all subsequent pointermove/up events
    // even if the finger leaves the canvas.
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch {}
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    dragRef.current = {
      pointerId: e.pointerId,
      startClientPos: { x: e.clientX, y: e.clientY },
      centerScreen: { x: cx, y: cy },
      lastPointerAngle: Math.atan2(e.clientY - cy, e.clientX - cx),
      crossedThreshold: false,
      samples: [{ time: performance.now(), rotation: rotationRef.current }],
      lastRenderedSegment: segmentAtRotation(rotationRef.current),
      carriedVelocity: carried,
    };
  }, [cancelInFlight, segmentAtRotation]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;

    if (!drag.crossedThreshold) {
      const dx = e.clientX - drag.startClientPos.x;
      const dy = e.clientY - drag.startClientPos.y;
      if (Math.hypot(dx, dy) < 6) return; // still might be a tap
      drag.crossedThreshold = true;
    }

    // Convert pointer position to angle around wheel center; the delta
    // since last frame is how far the wheel rotated under the finger.
    const angle = Math.atan2(e.clientY - drag.centerScreen.y, e.clientX - drag.centerScreen.x);
    let delta = angle - drag.lastPointerAngle;
    if (delta > Math.PI) delta -= 2 * Math.PI;
    if (delta < -Math.PI) delta += 2 * Math.PI;
    drag.lastPointerAngle = angle;
    rotationRef.current += delta;

    // Click sound on segment crossing (inline — cheap WebAudio).
    const seg = segmentAtRotation(rotationRef.current);
    if (seg !== drag.lastRenderedSegment) {
      drag.lastRenderedSegment = seg;
      lastRenderedSegmentRef.current = seg;
      setCurrentSegment(seg);
      playClickInline();
    }

    // Keep the last ~80ms of samples for release-velocity computation.
    const now = performance.now();
    drag.samples.push({ time: now, rotation: rotationRef.current });
    while (drag.samples.length > 1 && now - drag.samples[0].time > 80) {
      drag.samples.shift();
    }

    paint();
  }, [paint, segmentAtRotation]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch {}

    if (!drag.crossedThreshold) {
      // Stationary press → treat as tap → use the existing deterministic
      // spin path (with pre-scheduled audio and weighted-random winner).
      spin();
      return;
    }

    // Release velocity: angular distance over the last sample window.
    let dragVelocity = 0;
    if (drag.samples.length >= 2) {
      const first = drag.samples[0];
      const last = drag.samples[drag.samples.length - 1];
      const dt = last.time - first.time;
      if (dt > 0) dragVelocity = (last.rotation - first.rotation) / dt;
    }
    // Combine with any momentum carried over from a re-grabbed decay,
    // then clamp to MAX_VELOCITY. Same-direction flicks accumulate;
    // opposite-direction flicks subtract (or reverse direction). The
    // RELEASE_BOOST scales the user's input so the wheel feels lively
    // — a casual flick now produces a meaningful spin instead of a
    // lazy half-turn. The clamp keeps the click rate inside WebAudio's
    // comfort zone regardless of how aggressive the boost is.
    const RELEASE_BOOST = 2;
    let velocity = (dragVelocity + drag.carriedVelocity) * RELEASE_BOOST;
    if (velocity > MAX_VELOCITY) velocity = MAX_VELOCITY;
    else if (velocity < -MAX_VELOCITY) velocity = -MAX_VELOCITY;
    const isSpinAttempt = Math.abs(velocity) >= SPIN_ATTEMPT_VELOCITY;

    // No spin → just leave the wheel where the user dropped it.
    if (Math.abs(velocity) < STOP_VELOCITY) {
      paint();
      return;
    }

    // Momentum decay loop. Friction is exp-applied per ms so frame-rate
    // changes don't change the feel of the wind-down. Each frame: advance
    // rotation by velocity * dt, scale velocity by FRICTION^dt, fire a
    // click on segment crossings, paint. Bail when velocity dips below
    // the stop threshold.
    isSpinningRef.current = true;
    decayInterruptedRef.current = false;
    momentumVelocityRef.current = velocity;
    let lastFrameTime = performance.now();
    let lastSegment = segmentAtRotation(rotationRef.current);

    const decayFrame = (now: number) => {
      const dt = Math.min(50, now - lastFrameTime); // cap dt across long pauses
      lastFrameTime = now;
      rotationRef.current += velocity * dt;
      velocity *= Math.pow(FRICTION_PER_MS, dt);
      momentumVelocityRef.current = velocity;

      const seg = segmentAtRotation(rotationRef.current);
      if (seg !== lastSegment) {
        lastSegment = seg;
        lastRenderedSegmentRef.current = seg;
        setCurrentSegment(seg);
        playClickInline();
      }
      paint();

      if (Math.abs(velocity) > STOP_VELOCITY && !decayInterruptedRef.current) {
        animRef.current = requestAnimationFrame(decayFrame);
        return;
      }

      // Decay complete (or interrupted). Reset spinning flag.
      isSpinningRef.current = false;
      momentumVelocityRef.current = 0;
      const interrupted = decayInterruptedRef.current;
      decayInterruptedRef.current = false;
      if (interrupted || !isSpinAttempt) return;

      // Natural stop after a real spin attempt → fire the win flow.
      const idx = getWinningIndex();
      onFinished(idx);
      if (showWinAnimation) playWinOverlay(idx);
    };

    animRef.current = requestAnimationFrame(decayFrame);
  }, [spin, paint, segmentAtRotation, getWinningIndex, onFinished, showWinAnimation, playWinOverlay]);

  const handlePointerCancel = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch {}
  }, []);

  useImperativeHandle(ref, () => ({
    spin,
    reset,
    get isSpinning() { return isSpinningRef.current; },
  }), [spin, reset]);

  // Cleanup animations on unmount — cancels both the spin/decay slot
  // AND the win-overlay slot, plus the hold-timer between fade-in and
  // fade-out, so nothing leaks into the next mount.
  useEffect(() => {
    return () => {
      cancelAnimationFrame(animRef.current);
      cancelAnimationFrame(winAnimRef.current);
      if (winHoldTimerRef.current) clearTimeout(winHoldTimerRef.current);
    };
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
        // Disables native touch panning on the wheel — the drag-to-spin
        // gesture needs every pointermove and would otherwise compete
        // with the page scroll.
        touchAction: 'none',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        WebkitTouchCallout: 'none',
      }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
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
