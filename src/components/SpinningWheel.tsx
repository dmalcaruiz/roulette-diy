import { useRef, useEffect, useLayoutEffect, useCallback, useState, forwardRef, useImperativeHandle } from 'react';
import { createPortal } from 'react-dom';

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

// Pre-rendered tick + win voices (WAV files next to click.mp3). Each voice
// prefers its decoded buffer and falls back to live synthesis until it loads
// (or if the fetch fails), so sound is never lost.
const voiceBuffers: Record<string, AudioBuffer> = {};
let voiceLoadPromise: Promise<void> | null = null;
const VOICE_FILES: Record<string, string> = {
  blip: '/audio/blip.wav',
  fire: '/audio/fire.wav',
  ding: '/audio/ding.wav',
  zap: '/audio/zap.wav',
  win: '/audio/win.wav',
};
function ensureVoiceBuffers(): Promise<void> {
  if (voiceLoadPromise) return voiceLoadPromise;
  const ctx = getAudioCtx();
  if (!ctx) return Promise.resolve();
  voiceLoadPromise = (async () => {
    await Promise.all(Object.entries(VOICE_FILES).map(async ([name, url]) => {
      try {
        const res = await fetch(url);
        voiceBuffers[name] = await ctx.decodeAudioData(await res.arrayBuffer());
      } catch { /* leave unset → that voice falls back to live synth */ }
    }));
  })();
  return voiceLoadPromise;
}

// Kick off the loads eagerly so the buffers are decoded before the user spins.
ensureClickBuffer();
ensureVoiceBuffers();

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
    ensureVoiceBuffers();
    document.removeEventListener('pointerdown', unlock, true);
    document.removeEventListener('touchstart', unlock, true);
    document.removeEventListener('keydown', unlock, true);
  };
  document.addEventListener('pointerdown', unlock, true);
  document.addEventListener('touchstart', unlock, true);
  document.addEventListener('keydown', unlock, true);
}

// ── Tick sound packs ─────────────────────────────────────────────────────
// A wheel ticks with either the sampled click.mp3 (default 'click') or a
// synthesized triangle blip ported from the Spinly reference ('synth'), chosen
// per-wheel via the tickSound config option. Synth also gets a win arpeggio.

// Synthesized tick voices. Each is a short pitched blip with its own waveform,
// frequency, and envelope: `blip` is the bright triangle, `tok` a low woodblock,
// `ding` a soft bell, `zap` a falling arcade chirp.
interface TickSpec {
  type: OscillatorType;
  freq: number;     // base frequency (Hz)
  jitter: number;   // random Hz added per hit, so repeats don't sound identical
  peak: number;     // gain peak
  attack: number;   // s to peak
  decay: number;    // s to silence
  pitchTo?: number; // optional end frequency (a pitch sweep over `decay`)
}
const TICK_SPECS: Record<string, TickSpec> = {
  blip: { type: 'triangle', freq: 1250, jitter: 260, peak: 0.11, attack: 0.002, decay: 0.06 },
  ding: { type: 'sine',     freq: 920,  jitter: 120, peak: 0.10, attack: 0.003, decay: 0.16 },
  // 'fire' and 'zap' are multi-node (synthFireAt / synthZapAt), not this path.
};

// One synth tick. Returns the node so a pre-scheduled tick can be stopped if the
// spin is interrupted.
function synthTickAt(ctx: AudioContext, time: number, spec: TickSpec): AudioScheduledSourceNode {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = spec.type;
  o.frequency.setValueAtTime(spec.freq + Math.random() * spec.jitter, time);
  if (spec.pitchTo) o.frequency.exponentialRampToValueAtTime(spec.pitchTo, time + spec.decay);
  g.gain.setValueAtTime(0.0001, time);
  g.gain.exponentialRampToValueAtTime(spec.peak, time + spec.attack);
  g.gain.exponentialRampToValueAtTime(0.0001, time + spec.decay);
  o.connect(g).connect(ctx.destination);
  o.start(time);
  o.stop(time + spec.decay + 0.02);
  return o;
}

// White-noise buffer (cached) — the airy hiss in the laser.
let sharedNoiseBuffer: AudioBuffer | null = null;
function getNoiseBuffer(ctx: AudioContext): AudioBuffer {
  if (sharedNoiseBuffer && sharedNoiseBuffer.sampleRate === ctx.sampleRate) return sharedNoiseBuffer;
  const len = Math.floor(ctx.sampleRate * 0.4);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  sharedNoiseBuffer = buf;
  return buf;
}

// "Zap" laser — a thick descending sweep that actually goes "pssheeew": two
// DETUNED sawtooths for the tonal pew PLUS filtered NOISE swept down with it for
// the airy hiss. Returns every node so a pre-scheduled zap stops cleanly.
function synthZapAt(ctx: AudioContext, time: number): AudioScheduledSourceNode[] {
  const dur = 0.16;
  const startF = 2600 + Math.random() * 500;
  const endF = 170 + Math.random() * 60;
  const nodes: AudioScheduledSourceNode[] = [];

  // Tonal sweep — two slightly detuned saws (the detune is what thickens it).
  const toneGain = ctx.createGain();
  toneGain.gain.setValueAtTime(0.0001, time);
  toneGain.gain.exponentialRampToValueAtTime(0.08, time + 0.004);
  toneGain.gain.exponentialRampToValueAtTime(0.0001, time + dur);
  toneGain.connect(ctx.destination);
  for (const detune of [1, 1.011]) {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(startF * detune, time);
    o.frequency.exponentialRampToValueAtTime(endF * detune, time + dur);
    o.connect(toneGain);
    o.start(time);
    o.stop(time + dur + 0.02);
    nodes.push(o);
  }

  // Airy hiss — noise through a bandpass whose centre sweeps down with the pitch.
  const noise = ctx.createBufferSource();
  noise.buffer = getNoiseBuffer(ctx);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = 1.1;
  bp.frequency.setValueAtTime(startF * 1.3, time);
  bp.frequency.exponentialRampToValueAtTime(endF * 1.5, time + dur);
  const noiseGain = ctx.createGain();
  noiseGain.gain.setValueAtTime(0.0001, time);
  noiseGain.gain.exponentialRampToValueAtTime(0.06, time + 0.004);
  noiseGain.gain.exponentialRampToValueAtTime(0.0001, time + dur);
  noise.connect(bp).connect(noiseGain).connect(ctx.destination);
  noise.start(time);
  noise.stop(time + dur + 0.02);
  nodes.push(noise);

  return nodes;
}

// Soft-clip distortion curve (256 floats, built once at module load) — drives
// the "crunch" in the fire tick. Inferred type (no bare Float32Array
// annotation) so TS ≥5.7 keeps it Float32Array<ArrayBuffer>, which
// WaveShaperNode.curve requires.
const crunchCurve = (() => {
  const n = 256;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(x * 4); // soft saturation
  }
  return c;
})();

// "Fire" — a grainy, crunchy crackle (the element, not a gunshot): resonant
// low-passed noise for the grain + a low square for the body, BOTH pushed
// through a soft-clip waveshaper so it reads gritty/8-bit rather than clean.
// Returns every node so a pre-scheduled tick stops cleanly.
function synthFireAt(ctx: AudioContext, time: number): AudioScheduledSourceNode[] {
  const dur = 0.09;
  const nodes: AudioScheduledSourceNode[] = [];

  // Shared crunch stage: everything saturates here, then a master level out.
  const shaper = ctx.createWaveShaper();
  shaper.curve = crunchCurve;
  const out = ctx.createGain();
  out.gain.value = 0.2;
  shaper.connect(out).connect(ctx.destination);

  // Grain — noise through a RESONANT low-pass sweeping down (the crackle). The
  // playbackRate jitter varies the grain so repeats don't sound identical.
  const noise = ctx.createBufferSource();
  noise.buffer = getNoiseBuffer(ctx);
  noise.playbackRate.value = 0.6 + Math.random() * 0.6;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(2700 + Math.random() * 700, time);
  lp.frequency.exponentialRampToValueAtTime(650, time + dur);
  lp.Q.value = 7; // resonance = crunch
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(0.0001, time);
  ng.gain.exponentialRampToValueAtTime(0.5, time + 0.002);
  ng.gain.exponentialRampToValueAtTime(0.0001, time + dur);
  noise.connect(lp).connect(ng).connect(shaper);
  noise.start(time);
  noise.stop(time + dur + 0.02);
  nodes.push(noise);

  // Body — a low square dropping in pitch, gritty through the same shaper.
  const o = ctx.createOscillator();
  o.type = 'square';
  o.frequency.setValueAtTime(150 + Math.random() * 50, time);
  o.frequency.exponentialRampToValueAtTime(80, time + dur);
  const og = ctx.createGain();
  og.gain.setValueAtTime(0.0001, time);
  og.gain.exponentialRampToValueAtTime(0.35, time + 0.003);
  og.gain.exponentialRampToValueAtTime(0.0001, time + dur * 0.85);
  o.connect(og).connect(shaper);
  o.start(time);
  o.stop(time + dur + 0.02);
  nodes.push(o);

  return nodes;
}

// Play a decoded buffer once, optionally with a little per-hit pitch jitter so
// repeated ticks (one shared buffer) don't sound mechanically identical.
function playBuffer(ctx: AudioContext, buf: AudioBuffer, time: number, jitter: number): AudioScheduledSourceNode {
  const src = ctx.createBufferSource();
  src.buffer = buf;
  if (jitter) src.playbackRate.value = 1 + (Math.random() * 2 - 1) * jitter;
  src.connect(ctx.destination);
  src.start(time);
  return src;
}

// A tick generator bound to one chosen sound, resolved ONCE per sound (not per
// tick). Each voice plays its PRE-RENDERED buffer (cheap — like click), falling
// back to live synthesis only until that buffer decodes / if its file is
// missing. Returns every node created so callers can track them for cancel.
type TickFn = (ctx: AudioContext, time: number) => AudioScheduledSourceNode[];
function resolveTickFn(tickSound: string): TickFn {
  if (tickSound === 'click') {
    return (ctx, time) => (sharedClickBuffer ? [playBuffer(ctx, sharedClickBuffer, time, 0)] : []);
  }
  // Live-synth fallback for this voice (used only until its buffer is ready).
  const synth: TickFn =
    tickSound === 'fire' ? synthFireAt
      : tickSound === 'zap' ? synthZapAt
        : ((spec) => (ctx: AudioContext, time: number) => [synthTickAt(ctx, time, spec)])(TICK_SPECS[tickSound] ?? TICK_SPECS.blip);
  return (ctx, time) => {
    const buf = voiceBuffers[tickSound];
    return buf ? [playBuffer(ctx, buf, time, 0.06)] : synth(ctx, time);
  };
}

// Fire one inline tick now (drag / decay) with the already-resolved generator.
function playTickInline(fn: TickFn): void {
  const ctx = sharedAudioCtx;
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  fn(ctx, ctx.currentTime);
}

// Win arpeggio — a short rising triangle chord (Spinly). Only the synth pack
// plays a win sound; the sampled pack keeps just the visual flash.
function playWinChord(): void {
  const ctx = sharedAudioCtx;
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  // Prefer the pre-rendered arpeggio; fall back to live synthesis until it loads.
  if (voiceBuffers.win) { playBuffer(ctx, voiceBuffers.win, ctx.currentTime, 0); return; }
  const t = ctx.currentTime;
  const notes = [523.25, 659.25, 783.99, 1046.5];
  for (let i = 0; i < notes.length; i++) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'triangle';
    o.frequency.value = notes[i];
    const st = t + i * 0.085;
    g.gain.setValueAtTime(0.0001, st);
    g.gain.exponentialRampToValueAtTime(0.15, st + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, st + 0.5);
    o.connect(g).connect(ctx.destination);
    o.start(st);
    o.stop(st + 0.55);
  }
}
import { WheelItem } from '../models/types';
import { paintWheel, WheelPainterConfig, PIXEL_SCALE, WHEEL_FONT_FAMILY } from './WheelCanvas';
export { roughSeedFromId } from './WheelCanvas';
import { onVisualLoaded } from './segmentVisuals';
import CustomMarker from './CustomMarker';
import PixelatedMarker from './PixelatedMarker';
import DotCelebration, { DotCelebrationHandle } from './DotCelebration';

// Evaluate a CSS cubic-bezier(x1,y1,x2,y2) timing function in JS, so audio
// scheduled from it lines up exactly with a CSS `transition` using the same
// curve. Newton-Raphson with a bisection fallback (what browsers do internally).
function makeCubicBezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const sampleDX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const dx = sampleX(t) - x;
      if (Math.abs(dx) < 1e-5) return sampleY(t);
      const d = sampleDX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= dx / d;
    }
    let lo = 0, hi = 1; t = x;
    for (let i = 0; i < 20; i++) {
      const dx = sampleX(t) - x;
      if (Math.abs(dx) < 1e-5) break;
      if (dx < 0) lo = t; else hi = t;
      t = (lo + hi) / 2;
    }
    return sampleY(t);
  };
}

// Spin deceleration curve — fast launch, long gentle settle. Shared by the CSS
// transition (visual) and the JS evaluator (audio/header), so they stay locked.
const SPIN_EASE_CSS = 'cubic-bezier(0.12, 0.78, 0.16, 1)';
const SPIN_EASE_FN = makeCubicBezier(0.12, 0.78, 0.16, 1);

// Drag-RELEASE momentum decay uses a gentler curve. SPIN_EASE's initial slope
// (~6.5) makes the coast start at ~6.5× its average speed — far above the
// finger's actual release velocity, so the wheel visibly lurches faster the
// instant it's let go ("jumpy after release"). This curve's initial slope (~3)
// is in the range of the exponential-friction release velocity, so the hand-off
// from finger to coast is continuous. (Tap-spin keeps SPIN_EASE — it launches
// from rest, where a steep start reads as punchy, not jumpy.)
const DECAY_EASE_CSS = 'cubic-bezier(0.22, 0.66, 0.4, 1)';
const DECAY_EASE_FN = makeCubicBezier(0.22, 0.66, 0.4, 1);

// Wind-up curve — a quick ease-in-out reverse before the spin launches.
const PULLBACK_EASE_CSS = 'cubic-bezier(0.45, 0, 0.55, 1)';
const PULLBACK_EASE_FN = makeCubicBezier(0.45, 0, 0.55, 1);


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
  // Per-segment text auto-fit is always on (shrink-to-fit then middle "…").
  // This optional flag allows wrapping a long label onto 2 lines. Default off.
  textWrap?: boolean;
  // Extra ring outside the wheel edge, separate from `strokeWidth`. Default 0.
  outerStrokeWidth?: number;
  // Decorative dots around the outer stroke band (carnival-bulb bezel).
  outerStrokeDots?: boolean;
  bezelDotsColorMode?: 'default' | 'custom' | 'segment';
  bezelDotsCustomColor?: string;
  // Show a result dialog + dot celebration as the win overlay fades out.
  resultDialog?: boolean;
  showBackgroundCircle?: boolean;
  // Colour of the wheel's "white" parts — dividers + outer ring stroke and
  // the background circle. Default white.
  wheelBaseColor?: string;
  // Marker tuning: circle diameter (% of the marker box, both layers), peek
  // (% of that diameter the top layer lifts), and the TOP layer's base fill
  // colour (the bottom layer + strokes derive from it).
  markerDiameter?: number;
  markerPeek?: number;
  markerBaseColor?: string;
  // Draw the pin graphic on the marker. Default off (only the disc/ring stack).
  showPin?: boolean;
  // Tick sound: 'click' = sampled click.mp3 (default); the rest are synthesized
  // voices. The win arpeggio plays regardless of this choice.
  tickSound?: 'click' | 'blip' | 'fire' | 'ding' | 'zap';
  spinIntensity?: number;
  isRandomIntensity?: boolean;
  headerTextColor?: string;
  overlayColor?: string;
  showWinAnimation?: boolean;
  headerOpacity?: number;
  headerSizeProgress?: number;
  /** Vertical gap (px) between the segment header and the wheel canvas
   *  at headerSizeProgress=1. Defaults to 16. Multiplied by
   *  headerSizeProgress so the gap collapses with the header. */
  headerCanvasGap?: number;
  /** Optional CSS transition string applied to the header/spacer DOM
   *  elements whose size/opacity track headerOpacity + headerSizeProgress.
   *  Used so the header can animate via the browser compositor in
   *  lockstep with the parent's sheet/wheel transition — instead of
   *  reading new values per React render (which would force the parent
   *  to call setSheetHeight 60×/sec just to animate the header). */
  headerTransition?: string;
  // Fires after a ~500ms long-press on the wheel canvas (no movement
  // during the hold). Receives the index of the segment under the
  // pointer. Use to open an editor / context menu for that segment.
  onSegmentLongPress?: (index: number) => void;
  // Per-wheel roughness seed (e.g. roughSeedFromId(config.id)) so each wheel's
  // hand-drawn wobble differs. Stable per wheel; omitted → 0.
  roughSeed?: number;
}

export interface SpinningWheelHandle {
  spin: () => void;
  reset: () => void;
  /** Rotate so segment `idx`'s centre lands under the marker (top centre). */
  focusSegment: (idx: number) => void;
  isSpinning: boolean;
}

const SpinningWheel = forwardRef<SpinningWheelHandle, SpinningWheelProps>((props, ref) => {
  const {
    items,
    onFinished,
    size = 300,
    textSizeMultiplier = 1,
    headerTextSizeMultiplier = 1,
    imageSize = 110,
    cornerRadius = 8,
    innerCornerStyle = 'none',
    centerInset = 50,
    strokeWidth = 3,
    textWrap = false,
    outerStrokeWidth = 0,
    outerStrokeDots = false,
    bezelDotsColorMode = 'default',
    bezelDotsCustomColor,
    resultDialog = true,
    showBackgroundCircle = true,
    wheelBaseColor = '#FFFFFF',
    markerDiameter = 60,
    markerPeek = 0,
    markerBaseColor = '#FFFFFF',
    showPin = false,
    tickSound = 'click',
    spinIntensity = 0.5,
    isRandomIntensity = true,
    headerTextColor = '#FFFFFF',
    overlayColor = '#000000',
    showWinAnimation = true,
    headerOpacity = 1,
    headerSizeProgress = 1,
    headerCanvasGap = 16,
    headerTransition,
    onSegmentLongPress,
    roughSeed = 0,
  } = props;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Pixelate mode splits the wheel across two stacked canvases so text stays
  // crisp: the ART canvas (canvasRef) carries `image-rendering: pixelated`, the
  // TEXT canvas (labels/visuals) renders smooth. Both live inside the rotor div,
  // which is what the spin/decay transforms rotate — so they turn as one and the
  // marker (rotor's sibling) stays put.
  const textCanvasRef = useRef<HTMLCanvasElement>(null);
  // Win DIM layer: a dark mask (rough disc minus the winning wedge) composited
  // OVER the baked wheel and faded via CSS opacity — so the win dim tints the
  // already-rendered pixels instead of re-baking the wheel per frame.
  const dimCanvasRef = useRef<HTMLCanvasElement>(null);
  const rotorRef = useRef<HTMLDivElement>(null);
  const animRef = useRef<number>(0);
  const rotationRef = useRef(0);
  const isSpinningRef = useRef(false);

  // Rotation the canvas BITMAP is painted at. The live/visual rotation is
  // `rotationRef`; the difference (rotationRef − bakedRotation) is applied as a
  // CSS transform on the canvas element. This lets the tap-spin rotate on the
  // GPU compositor without re-rasterizing the wheel every frame.
  const bakedRotationRef = useRef(0);
  // The tap-spin rotates the canvas ELEMENT via a per-frame transform (cheap,
  // compositor-only) instead of rasterizing the wheel each frame. headerRaf is
  // that loop; gpuSpinActive guards paint() from re-baking mid-spin; spinStart
  // is the spin clock.
  const headerRafRef = useRef<number>(0);
  const gpuSpinActiveRef = useRef(false);
  const spinStartPerfRef = useRef<number>(0);
  const [isSpinning, setIsSpinning] = useState(false);
  // The tick generator is resolved ONCE whenever the sound changes (not per
  // tick), so firing a tick is a plain call with no branching/table lookup.
  const tickSoundRef = useRef<string>('click');
  const tickFnRef = useRef<TickFn>(resolveTickFn('click'));
  if (tickSoundRef.current !== tickSound) {
    tickSoundRef.current = tickSound;
    tickFnRef.current = resolveTickFn(tickSound);
  }
  const [currentSegment, setCurrentSegment] = useState('');
  // Header text element — written directly (no React re-render) during a live
  // finger drag, where a setState per segment crossing would saturate the main
  // thread and stall the transform that tracks the finger.
  const headerTextRef = useRef<HTMLDivElement>(null);
  const [segmentHeaderOpacity, setSegmentHeaderOpacity] = useState(1);

  // Overlay animation state
  const overlayOpacityRef = useRef(0);
  const winningIndexRef = useRef(-1);
  // True only while the win overlay is in its ACTIVE lifecycle (fade-in, hold,
  // natural fade-out) — NOT during a user-triggered dismiss fade. A tap stops an
  // active overlay; once it's being dismissed, the next tap spins normally.
  const winOverlayActiveRef = useRef(false);
  // True while a MOTION frame bakes → the painter skips the heavy palette-vote
  // quantization (cheap nearest instead) so drag moves and the rAF settle
  // animations stay smooth. Only ever set synchronously around a single bake
  // (see paintFrame / the transition tick), so it can never leak into the rest
  // frame — the final settle bake always quantizes for real.
  const fastBakeRef = useRef(false);
  // Quality of the currently COMMITTED (resting) bitmap: true when the last
  // paint() was a fast (non-quantized) motion bake, meaning a full-quality
  // re-bake is still owed once the wheel is genuinely at rest.
  const restBakeFastRef = useRef(false);
  // Result dialog + dot celebration, revealed as the win overlay fades out.
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const resultDialogRef = useRef(false);
  resultDialogRef.current = resultDialog;
  const celebrationRef = useRef<DotCelebrationHandle>(null);
  const [resultText, setResultText] = useState<string | null>(null);
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
  const scheduledSourcesRef = useRef<AudioScheduledSourceNode[]>([]);

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

  // Segment-set transition (smooth add/remove):
  //   - When `items` changes with the same length, snapshot the previous
  //     items as `fromItems` and animate `transition` 0 → 1 over 110ms.
  //     paintWheel interpolates per-segment weights AND lerps colors over
  //     that window. Combined with the WheelEditor sending a near-zero
  //     weight override on add (and animating to it on remove), the new /
  //     old segment grows / shrinks visibly instead of popping.
  //   - When length changes, no transition — just snap to the new items.
  //
  // MUST be a useLayoutEffect declared *before* the paint layoutEffect.
  // useEffect would run after the post-commit paint, so the first frame
  // after items changed would paint with the previous (stale) fromItems +
  // transition refs, then the transition setup would update them and the
  // next frame would re-paint differently — visible 1-frame flicker on
  // every add/remove.
  const fromItemsRef = useRef<WheelItem[] | null>(null);
  const transitionRef = useRef(1);
  const transitionAnimRef = useRef<number>(0);
  const prevItemsRef = useRef<WheelItem[]>(items);
  useLayoutEffect(() => {
    const prev = prevItemsRef.current;
    prevItemsRef.current = items;
    if (prev === items) return;
    cancelAnimationFrame(transitionAnimRef.current);
    if (prev.length !== items.length) {
      // Count change → no transition.
      fromItemsRef.current = null;
      transitionRef.current = 1;
      return;
    }
    // Only WEIGHTS animate here — colors/text snap instantly (by design) and
    // are covered by the prop-change repaint. Same-content identity changes are
    // common (live editor tweaks rebuild the items array per input event) and
    // used to kick off a phantom 110ms transition; harmless when every frame
    // re-baked identically, but now that mid-transition frames bake at FAST
    // pixelate quality it read as the wheel shimmering in place. Skip unless a
    // weight actually changed.
    if (prev.every((it, i) => it.weight === items[i].weight)) {
      fromItemsRef.current = null;
      transitionRef.current = 1;
      return;
    }
    // Same count → cross-fade weights/colors from prev → items.
    fromItemsRef.current = prev;
    transitionRef.current = 0;
    const start = performance.now();
    const duration = 110;
    // easeOutCubic: fast at the start, decelerates as the segment settles
    // into its final size. Reads as "snappy then settling" instead of the
    // mechanical linear ramp.
    const ease = (x: number) => 1 - Math.pow(1 - x, 3);
    const tick = (now: number) => {
      const tLin = Math.min(1, (now - start) / duration);
      transitionRef.current = ease(tLin);
      // Mid-transition frames skip the palette-vote (cheap pixelate); the final
      // repaint below runs with the flag clear, so the settled wheel quantizes.
      fastBakeRef.current = tLin < 1;
      repaint();
      fastBakeRef.current = false;
      if (tLin < 1) {
        transitionAnimRef.current = requestAnimationFrame(tick);
      } else {
        fromItemsRef.current = null;
        transitionRef.current = 1;
        repaint();
      }
    };
    transitionAnimRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(transitionAnimRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  // Build the painter config from the current props + refs. Shared by the wheel
  // bake (paintImpl) and the win dim-mask bake (paintDimMask) so both use the
  // exact same geometry (winner wedge aligns with the baked wheel).
  const buildWheelConfig = useCallback((): WheelPainterConfig => {
    const displaySize = size;
    // Segment-text auto-fit target: scales with wheel size, tapers past 16 slices.
    // Maps the slider's display value (0.1→0.30 … 1.0→0.95) to the render multiplier.
    const textMult = 0.3 + (textSizeMultiplier - 0.1) * (0.95 - 0.3) / (1.0 - 0.1);
    const fontSize = displaySize / Math.max(16, items.length) * textMult;
    return {
      items,
      rotation: bakedRotationRef.current,
      fontSize,
      cornerRadius,
      strokeWidth,
      textWrap,
      markerDiameter,
      outerStrokeWidth,
      outerStrokeDots,
      bezelDotsColorMode,
      bezelDotsCustomColor,
      showBackgroundCircle,
      wheelBaseColor,
      imageSize,
      overlayColor,
      // Nudge labels DOWN a touch — the 'middle' baseline sits a hair high in
      // the wedge. (Drawn as -textVerticalOffset, so negative = downward.)
      textVerticalOffset: displaySize / 700 * -1,
      innerCornerStyle,
      centerInset,
      overlayOpacity: overlayOpacityRef.current,
      winningIndex: winningIndexRef.current,
      loadingAngle: 0,
      fromItems: fromItemsRef.current,
      transition: transitionRef.current,
      roughSeed,
      fastPixelate: fastBakeRef.current,
    };
  }, [items, size, textSizeMultiplier, cornerRadius, strokeWidth, outerStrokeWidth, outerStrokeDots,
      bezelDotsColorMode, bezelDotsCustomColor, textWrap, markerDiameter,
      showBackgroundCircle, imageSize, overlayColor, innerCornerStyle, centerInset,
      wheelBaseColor, roughSeed]);

  // Render ONLY the win dim mask onto the dedicated dim canvas, composited over the
  // baked wheel. Called ONCE per win — its opacity is then CSS-animated (no re-bake).
  const paintDimMask = useCallback(() => {
    const canvas = dimCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const displaySize = size;
    if (canvas.width !== displaySize * dpr || canvas.height !== displaySize * dpr) {
      canvas.width = displaySize * dpr;
      canvas.height = displaySize * dpr;
    }
    const config = buildWheelConfig();
    config.dimMaskOnly = true;
    config.winningIndex = winningIndexRef.current;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    paintWheel(ctx, displaySize, displaySize, config);
  }, [size, buildWheelConfig]);

  // Paint implementation. Rebuilds whenever size/items/etc. change so it
  // reads the latest props and resizes the canvas's internal pixel buffer
  // to match.
  const paintImpl = useCallback(() => {
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

    const config = buildWheelConfig();

    // When pixelating, route labels/visuals to the smooth text canvas so they
    // don't inherit the art canvas's nearest-neighbour `image-rendering`.
    let textCtx: CanvasRenderingContext2D | null = null;
    if (PIXEL_SCALE > 1) {
      const textCanvas = textCanvasRef.current;
      if (textCanvas) {
        textCtx = textCanvas.getContext('2d');
        if (textCtx) {
          if (textCanvas.width !== displaySize * dpr || textCanvas.height !== displaySize * dpr) {
            textCanvas.width = displaySize * dpr;
            textCanvas.height = displaySize * dpr;
          }
          textCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
          textCtx.clearRect(0, 0, displaySize, displaySize);
        }
      }
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    paintWheel(ctx, displaySize, displaySize, config, textCtx);
  }, [size, buildWheelConfig]);

  // Public `paint` is *stable* (never changes identity) but always invokes
  // the latest paintImpl via a ref. The spin/decay rAF callbacks capture
  // paint at spin-start; without this indirection, a size change mid-spin
  // (e.g. closing the segment sheet → wheel resizing back to full) would
  // leave the captured closure using the old size, so the canvas's pixel
  // buffer stayed at small DPR-scaled dimensions while CSS stretched it
  // to the new display size — visible pixelation until the next spin
  // rebuilt its closure. Routing through the ref keeps every existing
  // call site automatically up-to-date with no other code changes.
  const paintImplRef = useRef(paintImpl);
  paintImplRef.current = paintImpl;
  // Paint the wheel at the CURRENT visual rotation and clear the element
  // transform — i.e. "commit" the rotation into the bitmap. Every interactive
  // path (drag, decay, reset, transitions, win flash, initial) calls this; only
  // the GPU tap-spin bypasses it to animate the element transform instead.
  const paint = useCallback(() => {
    // Guarded during a tap-spin: the canvas stays baked at the start rotation
    // while the element transform animates, so a stray paint() (e.g. from a
    // prop-change effect) must not re-bake and desync the transform.
    if (gpuSpinActiveRef.current) return;
    bakedRotationRef.current = rotationRef.current;
    paintImplRef.current();
    restBakeFastRef.current = fastBakeRef.current; // remember committed quality
    const c = rotorRef.current;
    // Clear any spin/drag transition + transform so the just-baked bitmap shows
    // at identity. NO translateZ/will-change here: painting while layer-promoted
    // re-uploads the whole texture per bake (that was the historical drag
    // stutter). The drag/tap/decay transforms self-promote a layer via the
    // translateZ(0) in THEIR transforms, only while they run — during which
    // nothing re-bakes.
    if (c) { c.style.transition = 'none'; c.style.transform = 'none'; }
  }, []);

  // Keep the wheel canvas on its own GPU layer (identity transform) during the win
  // overlay / result dialog. paint() resets the transform to 'none' (no layer), and
  // when the dialog's translucent layer composites over an un-layered pixelated
  // canvas the browser re-rasterizes it — which read as a "wiggle" while the aviso
  // was up. translateZ(0) is visually identity but forces a stable cached layer.
  const keepWheelLayer = useCallback(() => {
    const r = rotorRef.current;
    if (r) r.style.transform = 'translateZ(0)';
  }, []);

  // Like paint(), but safe to call WHILE a GPU tap-spin is animating. paint() is
  // guarded mid-spin (it would re-bake at the estimated rotation and reset the
  // element transform — stopping the spin). Here we instead redraw only the
  // CONTENT at the already-baked rotation and leave the transform running, so an
  // items / colour swap (Surprise me, vibe, a late-loading image) updates the
  // wheel live, mid-spin, without stopping it.
  const repaint = useCallback(() => {
    if (gpuSpinActiveRef.current) paintImplRef.current();
    else paint();
  }, [paint]);

  // Initial paint and repaint on prop changes — useLayoutEffect (not
  // useEffect) so the canvas is drawn synchronously after layout BEFORE the
  // browser paints the frame. With useEffect there's a one-frame gap where
  // the canvas exists but is unpainted, which on a remount (e.g. tapping +
  // to add a new wheel) shows up as a white flash.
  // Paint is deferred via useEffect + rAF instead of useLayoutEffect so
  // the canvas draw (which can take 30-50ms for wheels with 100+ segments)
  // doesn't block the React commit / browser-paint cycle that triggers
  // the CSS slide-in animation on a wheel switch. With useLayoutEffect
  // the paint ran synchronously BEFORE the browser composited the first
  // frame, so the slide-in literally couldn't start until paint finished.
  // With this rAF defer:
  //   • frame 0: React commit → DOM updated → browser composites first
  //     slide frame (canvas blank, but at translateX(100%) it's fully
  //     off-screen so nobody sees the blank).
  //   • frame 1: rAF fires → paintWheel runs synchronously → next
  //     browser composite shows the painted canvas.
  // Net: the slide starts ~30-50ms sooner and the brief unpainted frame
  // is hidden behind the slide's off-screen start position.
  // Depends on paintImpl (the actual implementation) so it re-fires on
  // size/items/etc changes; the public `paint` is intentionally stable.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      // A live drag owns the canvas: skip prop-driven repaints — each is a
      // full mid-drag bake (= a skipped frame), and the release settle paint()
      // reads the latest config via paintImplRef anyway, so a config change
      // that lands mid-drag still shows the moment the finger lifts.
      if (dragRef.current) return;
      repaint();
    });
    return () => cancelAnimationFrame(id);
  }, [repaint, paintImpl]);

  // Repaint when a segment's custom image finishes decoding. The painter skips
  // not-yet-loaded images (showing a faint placeholder); this brings them in.
  useEffect(() => onVisualLoaded(() => repaint()), [repaint]);

  // Re-bake once the wheel label font finishes loading: the fitted-text memo
  // keys on fonts.check(), so this repaint re-measures + redraws every label
  // in the real pixel face instead of the fallback's metrics.
  useEffect(() => {
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    if (!fonts) return;
    let cancelled = false;
    fonts.load(`600 16px ${WHEEL_FONT_FAMILY}`)
      .then(() => { if (!cancelled) repaint(); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [repaint]);

  // Update segment on mount
  useEffect(() => {
    updateCurrentSegment();
  }, [updateCurrentSegment]);

  // Easing function (easeOutCubic)
  const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
  const easeInOut = (t: number) => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  // CSS twin of easeInOut (quad), for the compositor-driven settle transitions
  // (reset / focusSegment) that used to run as per-frame re-bake rAF loops.
  const EASE_IN_OUT_CSS = 'cubic-bezier(0.455, 0.03, 0.515, 0.955)';

  // Cancel any in-flight spin/decay animation + scheduled audio so a new
  // drag starts from a clean slate. Deliberately does NOT touch the win-
  // overlay animation (winAnimRef / winHoldTimerRef) — once a win flash
  // begins it must run to completion regardless of subsequent gestures.
  const cancelInFlight = useCallback(() => {
    cancelAnimationFrame(animRef.current);
    cancelAnimationFrame(headerRafRef.current);
    if (gpuSpinActiveRef.current) {
      gpuSpinActiveRef.current = false;
      // Freeze at the EXACT visual rotation. A tap-spin runs as a CSS transition
      // on the compositor, while rotationRef is only an analytic estimate that
      // can drift a frame or two — baking the estimate snaps the wheel the
      // instant you grab ("harsh"). Read the live transform matrix and rebuild
      // the absolute rotation: the matrix gives the angle mod 2π, the estimate
      // supplies the turn count.
      const rotor = rotorRef.current;
      if (rotor) {
        try {
          const m = new DOMMatrixReadOnly(getComputedStyle(rotor).transform);
          const matrixTheta = Math.atan2(m.b, m.a);
          const approxDelta = rotationRef.current - bakedRotationRef.current;
          const k = Math.round((approxDelta - matrixTheta) / (2 * Math.PI));
          rotationRef.current = bakedRotationRef.current + matrixTheta + k * 2 * Math.PI;
        } catch { /* DOMMatrix string ctor unsupported → keep the estimate */ }
      }
      // Freezing a wheel in LIVE MOTION (spin/decay): the frozen frame is
      // transient — it's being re-grabbed or immediately re-baked by the
      // caller — so skip the palette-vote + readback. Full quality is restored
      // by the next rest-frame paint (stillness commit, release settle,
      // finishDecay, or the caller's own target bake).
      fastBakeRef.current = isSpinningRef.current;
      paint();
      fastBakeRef.current = false;
    }
    for (const s of scheduledSourcesRef.current) {
      try { s.stop(); } catch {}
    }
    scheduledSourcesRef.current = [];
  }, [paint]);

  // Win-overlay flash. Lives in its own animation slot so user gestures
  // (drag-to-spin, tap-to-spin, anything that calls cancelInFlight) can
  // never stop it mid-fade. Cancels only a *previous* win flash that's
  // still in flight, so a fresh win starts cleanly.
  // Graceful interrupt — fade the overlay out from its CURRENT opacity
  // (so it doesn't pop) over WIN_INTERRUPT_FADE_MS. Used when the user
  // grabs the wheel mid-win-animation: we don't want the dark tint to
  // sit on top of their drag, but we also don't want a hard cut.
  const WIN_INTERRUPT_FADE_MS = 180;
  const OVERLAY_FADE_MS = 400;
  const DIM_MAX = 0.7;              // matches the old overlayOpacity * 0.7 dim cap

  // Fade the dim layer out, then un-promote + settle to the plain rest frame.
  const cancelWinOverlay = useCallback(() => {
    if (winningIndexRef.current === -1) return; // nothing in flight
    winOverlayActiveRef.current = false;
    cancelAnimationFrame(winAnimRef.current);
    if (winHoldTimerRef.current) { clearTimeout(winHoldTimerRef.current); winHoldTimerRef.current = null; }
    const dim = dimCanvasRef.current;
    if (dim) { dim.style.transition = `opacity ${WIN_INTERRUPT_FADE_MS}ms ease`; dim.style.opacity = '0'; }
    winHoldTimerRef.current = setTimeout(() => {
      winHoldTimerRef.current = null;
      winningIndexRef.current = -1;
      paint(); // un-promote the wheel layer; back to the plain rest frame
    }, WIN_INTERRUPT_FADE_MS);
  }, [paint]);

  // Win flash. The wheel is already baked (at rest), so we render the dim MASK once
  // (dark disc with the winning wedge punched out) onto its own canvas and animate
  // ITS opacity via CSS — the dim tints the already-rendered pixels with ZERO
  // per-frame wheel re-bake.
  const playWinOverlay = useCallback((idx: number) => {
    playWinChord();
    cancelAnimationFrame(winAnimRef.current);
    if (winHoldTimerRef.current) { clearTimeout(winHoldTimerRef.current); winHoldTimerRef.current = null; }
    winningIndexRef.current = idx;
    winOverlayActiveRef.current = true;
    keepWheelLayer();   // promote the wheel group so the dialog can't re-raster it
    paintDimMask();     // render the dim mask once for this winner
    const dim = dimCanvasRef.current;
    if (dim) {
      dim.style.transition = 'none';
      dim.style.opacity = '0';
      void dim.offsetWidth;   // commit the 0 before transitioning in
      dim.style.transition = `opacity ${OVERLAY_FADE_MS}ms ease`;
      dim.style.opacity = String(DIM_MAX);
    }
    if (resultDialogRef.current) {
      // Dialog mode: after the fade-in + a beat, reveal the dialog + celebration.
      // The dim HOLDS at full opacity until the dialog is dismissed (cancelWinOverlay).
      winHoldTimerRef.current = setTimeout(() => {
        winHoldTimerRef.current = null;
        const its = itemsRef.current;
        setResultText(its[winningIndexRef.current]?.text ?? '');
        const cols = Array.from(new Set(its.map((it) => it.color)));
        cols.push('#FFD23D', '#FFFFFF');
        celebrationRef.current?.burst(cols);
      }, OVERLAY_FADE_MS + 250);
    } else {
      // No dialog: hold the flash, then fade it out.
      winHoldTimerRef.current = setTimeout(() => {
        winHoldTimerRef.current = null;
        const d = dimCanvasRef.current;
        if (d) { d.style.transition = `opacity ${OVERLAY_FADE_MS}ms ease`; d.style.opacity = '0'; }
        winHoldTimerRef.current = setTimeout(() => {
          winHoldTimerRef.current = null;
          winningIndexRef.current = -1;
          winOverlayActiveRef.current = false;
          paint(); // un-promote, settle to rest
        }, OVERLAY_FADE_MS);
      }, OVERLAY_FADE_MS + 2000);
    }
  }, [playWinChord, paintDimMask, keepWheelLayer, paint]);

  // ── Momentum decay launcher ──
  // The flick physics as ONE compositor CSS transition (smooth even under
  // main-thread load — a per-frame rAF version stuttered). Exponential
  // friction has a closed form, so the rest point + stop time are computed
  // analytically and we transition there with a decel curve. A read-only rAF
  // tracks the angle for the header, ticks, the win check, and momentum carry.
  // Shared by the drag release (handlePointerUp) and the mid-spin SPIN-press
  // boost. Caller must have frozen/committed the current rotation first.
  const launchDecay = useCallback((velocity: number) => {
    if (Math.abs(velocity) < STOP_VELOCITY) { paint(); return; } // nothing to launch
    const isSpinAttempt = Math.abs(velocity) >= SPIN_ATTEMPT_VELOCITY;
    isSpinningRef.current = true;
    decayInterruptedRef.current = false;
    momentumVelocityRef.current = velocity;
    const decayStartRotation = rotationRef.current;

    // Closed form of `rotation += v·dt; v *= F^dt`: rotation(t) = r0 + v0·(Fᵗ−1)/lnF.
    // Stops when |v| dips below STOP_VELOCITY.
    const lnF = Math.log(FRICTION_PER_MS);
    const decayDurationMs = Math.log(STOP_VELOCITY / Math.abs(velocity)) / lnF;
    const decayDelta = (Math.sign(velocity) * STOP_VELOCITY - velocity) / lnF;
    const decayTarget = decayStartRotation + decayDelta;

    // Bake at the FINAL (rest) orientation, then let the transform unwind to
    // identity so the fling lands on a pixel-clean, screen-aligned frame.
    gpuSpinActiveRef.current = false;
    rotationRef.current = decayTarget;   // paint() bakes at rotationRef → bake the FINAL orientation
    // A brisk fling's target bake is only ever seen in motion (finishDecay
    // re-quantizes the true rest frame) — skip the palette-vote for it. Slow
    // nudges keep the full bake: their whole decay is a visible crawl.
    fastBakeRef.current = isSpinAttempt;
    paint();                          // bakedRotationRef ← decayTarget; transform cleared to none (= rest)
    fastBakeRef.current = false;
    rotationRef.current = decayStartRotation;
    gpuSpinActiveRef.current = true;
    spinStartPerfRef.current = performance.now();

    const decayCanvas = rotorRef.current;
    if (decayCanvas) {
      // paint() left transform at none (= rest); set the start offset first.
      decayCanvas.style.transition = 'none';
      decayCanvas.style.transform = `rotate(${-decayDelta}rad) translateZ(0)`;
      void decayCanvas.offsetWidth;   // commit the start-offset state
      requestAnimationFrame(() => {
        if (!gpuSpinActiveRef.current) return; // grabbed/cancelled before it began
        decayCanvas.style.transition = `transform ${decayDurationMs / 1000}s ${DECAY_EASE_CSS}`;
        decayCanvas.style.transform = `rotate(0rad) translateZ(0)`;
      });
    }

    let lastSegment = segmentAtRotation(decayStartRotation);

    const finishDecay = () => {
      gpuSpinActiveRef.current = false;
      cancelAnimationFrame(headerRafRef.current);
      rotationRef.current = decayTarget;
      paint();                        // commit the rest rotation
      isSpinningRef.current = false;
      momentumVelocityRef.current = 0;
      if (decayInterruptedRef.current) { decayInterruptedRef.current = false; return; }
      if (!isSpinAttempt) return;
      // Natural stop after a real spin attempt → fire the win flow, gated on a
      // minimum travel so a lazy flick doesn't earn a celebration.
      const idx = getWinningIndex();
      onFinished(idx);
      const MIN_WIN_REVOLUTIONS = 1.3;
      if (showWinAnimation && Math.abs(decayDelta) / (2 * Math.PI) >= MIN_WIN_REVOLUTIONS) playWinOverlay(idx);
    };

    const decayTick = () => {
      const elapsed = performance.now() - spinStartPerfRef.current;
      const p = Math.min(1, elapsed / decayDurationMs);
      rotationRef.current = decayStartRotation + decayDelta * DECAY_EASE_FN(p);
      // Momentum carry for re-grab: numeric derivative of the curve (rad/ms).
      const epsMs = 8;
      const pPrev = Math.max(0, (elapsed - epsMs) / decayDurationMs);
      momentumVelocityRef.current = (decayDelta * (DECAY_EASE_FN(p) - DECAY_EASE_FN(pPrev))) / epsMs;
      const seg = segmentAtRotation(rotationRef.current);
      if (seg !== lastSegment) {
        lastSegment = seg;
        lastRenderedSegmentRef.current = seg;
        setCurrentSegment(seg);
        playTickInline(tickFnRef.current);
      }
      if (elapsed < decayDurationMs && !decayInterruptedRef.current) {
        headerRafRef.current = requestAnimationFrame(decayTick);
      } else {
        finishDecay();
      }
    };
    headerRafRef.current = requestAnimationFrame(decayTick);
  }, [paint, segmentAtRotation, getWinningIndex, onFinished, showWinAnimation, playWinOverlay]);

  const spin = useCallback(() => {
    if (isSpinningRef.current) {
      // Mid-spin press ADDS momentum instead of being ignored: freeze the
      // live motion at its exact angle (cheap bake — it's transient), add a
      // button-press worth of velocity in the direction of travel, and
      // relaunch as a physics decay — the winner then resolves from the
      // actual resting rotation, exactly like a re-flick. Capped at
      // MAX_VELOCITY, the same ceiling as every other spin source.
      const v0 = momentumVelocityRef.current;
      cancelInFlight();
      // Direction of travel. The tap-spin's brief wind-up (a small NEGATIVE
      // velocity right before the forward launch) counts as forward, so a
      // rapid double-press can't fire the wheel backwards.
      const dir = v0 < -0.006 ? -1 : 1;
      const v = Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, v0 + dir * SPIN_PRESS_BOOST));
      launchDecay(v);
      return;
    }
    // A compositor settle animation (reset / focusSegment) may be mid-flight —
    // freeze it at its exact visual angle before reading rotationRef, and kill
    // its pending settle watcher so it can't fire into THIS spin. (The gesture
    // path already ran this via pointerdown, where it's a no-op.)
    cancelInFlight();

    // The spin click is a user gesture — resume the AudioContext now so
    // the scheduled clicks below can fire on the audio thread. Also kick
    // off buffer loading if it hasn't completed yet (cheap no-op if
    // already loaded).
    const gestureCtx = getAudioCtx();
    if (gestureCtx && gestureCtx.state === 'suspended') gestureCtx.resume().catch(() => {});
    ensureClickBuffer();
    ensureVoiceBuffers();

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

    // Revolutions + winner alignment → total rotation delta from the rest
    // position so the winning segment lands under the marker.
    const baseRotations = isRandomIntensity
      ? 3 + Math.floor(effectiveIntensity * 7)
      : 3 + Math.floor(effectiveIntensity * 9);
    const totalRotations = isRandomIntensity
      ? baseRotations + Math.random()
      : baseRotations + Math.random() * 0.2;
    let winningAngle = 0;
    const winningSegmentSize = arcSize * items[winningIndex].weight;
    for (let i = 0; i <= winningIndex; i++) winningAngle += arcSize * items[i].weight;
    const segOffset = Math.random() * winningSegmentSize;
    const finalRotation = totalRotations * 2 * Math.PI + (2 * Math.PI - winningAngle + segOffset);

    // Duration (ms) — scales with intensity.
    const baseDuration = isRandomIntensity
      ? 2000 + effectiveIntensity * 4000
      : 1500 + effectiveIntensity * 5500;
    const durationOffset = isRandomIntensity ? Math.random() * 500 - 250 : Math.random() * 100 - 50;
    const durationMs = baseDuration + durationOffset;

    // Wind-up — a short reverse rotation (a few degrees) before the launch, so
    // it reads as anticipation rather than a real backspin.
    const pullbackAmount = (isRandomIntensity
      ? (10 + effectiveIntensity * 35) + (Math.random() - 0.5) * 10
      : (5 + effectiveIntensity * 45) + (Math.random() - 0.5) * 2) * (Math.PI / 180);
    const pullbackDurationMs = isRandomIntensity
      ? 200 + effectiveIntensity * 100
      : 150 + effectiveIntensity * 200;
    const totalMs = pullbackDurationMs + durationMs;

    const startRotation = rotationRef.current;

    // Trajectory shared by the audio scheduler + the read-only header loop, so
    // both stay locked to the two chained CSS transitions: a quick wind-up to
    // −pullback, then the main spin to finalRotation.
    const rotAtElapsed = (ms: number): number => {
      if (ms <= 0) return startRotation;
      if (ms < pullbackDurationMs) {
        return startRotation - pullbackAmount * PULLBACK_EASE_FN(ms / pullbackDurationMs);
      }
      const p = Math.min(1, (ms - pullbackDurationMs) / durationMs);
      return (startRotation - pullbackAmount) + (pullbackAmount + finalRotation) * SPIN_EASE_FN(p);
    };

    // ── Faithful Spinly mechanism: CSS transitions drive the rotation on the
    // compositor thread — no per-frame JS touches the transform, so it stays
    // smooth even under main-thread load. Phase 1 (wind-up) starts now; phase 2
    // (main spin) is flipped on by the read-only loop once the wind-up elapses.
    // That loop also drives the header — like Spinly's tickLoop. ─────────────
    // Bake at the FINAL orientation up front, then let the CSS transform UNWIND to
    // identity. The wheel lands on this exact screen-aligned, hard-pixel frame with
    // no end-of-spin re-bake and no tilted-pixel landing. The transform carries the
    // whole rotation as an offset (start angle = −finalRotation, rest = 0), so the
    // visible trajectory is unchanged — only the resting frame is now pixel-clean.
    const finalAbs = startRotation + finalRotation;
    rotationRef.current = startRotation;
    paint();                          // bake at START for the wind-up (near-still, so keep it clean)
    gpuSpinActiveRef.current = true;
    spinStartPerfRef.current = performance.now();

    const canvasEl = rotorRef.current;
    if (canvasEl) {
      // Wind-up runs on the START-orientation bake, transform from identity.
      canvasEl.style.transition = 'none';
      canvasEl.style.transform = 'rotate(0rad) translateZ(0)';
      void canvasEl.offsetWidth;
      requestAnimationFrame(() => {
        if (!gpuSpinActiveRef.current) return; // cancelled before it started
        canvasEl.style.transition = `transform ${pullbackDurationMs / 1000}s ${PULLBACK_EASE_CSS}`;
        canvasEl.style.transform = `rotate(${-pullbackAmount}rad) translateZ(0)`;
      });
    }

    // Pre-schedule clicks on the WebAudio thread against the SAME bezier the CSS
    // transition uses — sample-accurate AND aligned to the visual, immune to
    // rAF jitter. Cancel any sources still queued from a previous spin first.
    for (const s of scheduledSourcesRef.current) {
      try { s.stop(); } catch {}
    }
    scheduledSourcesRef.current = [];
    const ctx = sharedAudioCtx;
    const tick = tickSoundRef.current;
    const scheduleStartPerf = performance.now();
    const doScheduleClicks = () => {
      if (!ctx || (tick === 'click' && !sharedClickBuffer)) return;
      const resumeDelayMs = performance.now() - scheduleStartPerf;
      const audioBaseTime = ctx.currentTime - resumeDelayMs / 1000;
      const samples = 600;
      let prevSeg = segmentAtRotation(startRotation);
      // 100/sec cap so dense wheels don't produce an overwhelming click stream.
      const MIN_CLICK_GAP_SEC = 1 / 100;
      let lastScheduledClickTime = -Infinity;
      for (let i = 1; i <= samples; i++) {
        const tMs = (i / samples) * totalMs;
        const rot = rotAtElapsed(tMs);
        const seg = segmentAtRotation(rot);
        if (seg !== prevSeg) {
          const scheduledTime = audioBaseTime + tMs / 1000;
          if (scheduledTime > ctx.currentTime - 0.005
              && scheduledTime - lastScheduledClickTime >= MIN_CLICK_GAP_SEC) {
            const nodes = tickFnRef.current(ctx, Math.max(scheduledTime, ctx.currentTime));
            scheduledSourcesRef.current.push(...nodes);
            lastScheduledClickTime = scheduledTime;
          }
          prevSeg = seg;
        }
      }
    };
    if (ctx && (tick !== 'click' || sharedClickBuffer)) {
      if (ctx.state === 'running') doScheduleClicks();
      else ctx.resume().then(doScheduleClicks).catch(() => {});
    }

    // Read-only loop — updates the header text + winner index analytically from
    // the SAME bezier. It does NOT touch the transform (the CSS transition owns
    // it on the compositor thread), so main-thread jank here cannot stutter the
    // spin — exactly Spinly's read-only tickLoop.
    let lastSegment = segmentAtRotation(startRotation);
    lastRenderedSegmentRef.current = lastSegment;

    const finishSpin = () => {
      gpuSpinActiveRef.current = false;
      cancelAnimationFrame(headerRafRef.current);
      // Commit the resting rotation into the bitmap; paint() also clears the
      // transition + transform so nothing animates back.
      rotationRef.current = startRotation + finalRotation;
      paint();
      isSpinningRef.current = false;
      setIsSpinning(false);
      const idx = getWinningIndex();
      onFinished(idx);
      // Win flash runs on its own slot — once kicked off it can't be
      // interrupted by a subsequent drag.
      if (showWinAnimation) playWinOverlay(idx);
    };

    let phase2Started = false;
    const tickLoop = () => {
      const elapsed = performance.now() - spinStartPerfRef.current;
      // Hand off to the main-spin transition once the wind-up has elapsed.
      if (!phase2Started && elapsed >= pullbackDurationMs) {
        phase2Started = true;
        if (canvasEl) {
          // End of wind-up: re-bake at the FINAL orientation, then unwind the
          // transform to identity so the main spin LANDS on that pixel-clean frame.
          // paint() is guarded mid-spin, so drive the painter directly.
          bakedRotationRef.current = finalAbs;
          paintImplRef.current();
          // Hold the current wind-up-end angle (start − pullback) under the new
          // bake — transform = (start−pullback) − finalAbs — with no transition,
          // force a reflow, then animate to identity.
          canvasEl.style.transition = 'none';
          canvasEl.style.transform = `rotate(${-pullbackAmount - finalRotation}rad) translateZ(0)`;
          void canvasEl.offsetWidth;
          canvasEl.style.transition = `transform ${durationMs / 1000}s ${SPIN_EASE_CSS}`;
          canvasEl.style.transform = `rotate(0rad) translateZ(0)`;
        }
      }
      rotationRef.current = rotAtElapsed(elapsed);
      // Live velocity (rad/ms) — lets a mid-spin SPIN press (and a re-grab)
      // carry the current momentum. Numeric derivative, like the decay tick.
      momentumVelocityRef.current = (rotationRef.current - rotAtElapsed(Math.max(0, elapsed - 8))) / 8;
      const seg = segmentAtRotation(rotationRef.current);
      if (seg !== lastSegment) {
        lastSegment = seg;
        lastRenderedSegmentRef.current = seg;
        setCurrentSegment(seg);
      }
      if (elapsed < totalMs) {
        headerRafRef.current = requestAnimationFrame(tickLoop);
      } else {
        finishSpin();
      }
    };
    headerRafRef.current = requestAnimationFrame(tickLoop);
  }, [items, spinIntensity, isRandomIntensity, showWinAnimation, paint, cancelInFlight, launchDecay,
      segmentAtRotation, getWinningIndex, getRandomWeightedIndex, onFinished, playWinOverlay]);

  const reset = useCallback(() => {
    // Freeze any in-flight spin/decay/focus at its EXACT visual angle (matrix
    // read + bake) and stop scheduled ticks, so the settle below starts from
    // where the wheel actually is.
    cancelInFlight();
    isSpinningRef.current = false;
    setIsSpinning(false);
    setSegmentHeaderOpacity(0);

    overlayOpacityRef.current = 0;
    winningIndexRef.current = -1;
    winOverlayActiveRef.current = false;
    if (winHoldTimerRef.current) { clearTimeout(winHoldTimerRef.current); winHoldTimerRef.current = null; }
    if (dimCanvasRef.current) { dimCanvasRef.current.style.transition = 'none'; dimCanvasRef.current.style.opacity = '0'; }

    const current = rotationRef.current;
    const fullRotation = 2 * Math.PI;
    const numRotations = Math.round(current / fullRotation);
    const closest = numRotations * fullRotation;

    if (Math.abs(current - closest) < 0.01) {
      paint();
      return;
    }

    // Animate to the closest full rotation on the COMPOSITOR, like the
    // tap-spin/decay: bake ONCE at the target, offset the rotor transform back
    // to the current angle, and transition to identity. No per-frame re-bakes.
    const delta = closest - current;
    const duration = 500;
    rotationRef.current = closest;
    paint();                          // full-quality bake at the target; transform cleared
    const rotor = rotorRef.current;
    if (!rotor) return;
    gpuSpinActiveRef.current = true;  // guards stray paints; cancelInFlight re-freezes exactly
    rotor.style.transition = 'none';
    rotor.style.transform = `rotate(${-delta}rad) translateZ(0)`;
    void rotor.offsetWidth;           // commit the start-offset state
    requestAnimationFrame(() => {
      if (!gpuSpinActiveRef.current) return; // cancelled before it began
      rotor.style.transition = `transform ${duration}ms ${EASE_IN_OUT_CSS}`;
      rotor.style.transform = 'rotate(0rad) translateZ(0)';
    });
    // Settle watcher — read-only rAF on headerRafRef so every interrupt path
    // (cancelInFlight, a new reset/focus) cancels it. The +50ms grace covers
    // the one-frame-late CSS transition start; the ease ends flat, so any
    // residual angle at settle is sub-pixel.
    const startTime = performance.now();
    const tick = (now: number) => {
      if (!gpuSpinActiveRef.current) return; // interrupted
      if (now - startTime < duration + 50) {
        headerRafRef.current = requestAnimationFrame(tick);
      } else {
        gpuSpinActiveRef.current = false;
        paint();                      // commit the rest frame (un-promotes the layer)
      }
    };
    headerRafRef.current = requestAnimationFrame(tick);
  }, [cancelInFlight, paint]);

  // Rotate so segment `idx`'s centre lands under the marker (top centre).
  // Animates like reset() — rAF + paint() to the shortest-path target angle.
  const focusSegment = useCallback((idx: number) => {
    if (idx < 0 || idx >= items.length) return;
    // Freeze any in-flight animation at its EXACT visual angle (matrix read +
    // bake), so the shortest-path delta below starts from where the wheel is.
    cancelInFlight();
    isSpinningRef.current = false;

    const totalWeight = items.reduce((s, it) => s + it.weight, 0);
    if (totalWeight <= 0) return;
    let acc = 0;
    for (let i = 0; i < idx; i++) acc += items[i].weight;
    const segCenter = ((acc + items[idx].weight / 2) / totalWeight) * 2 * Math.PI;
    // The marker reads the wheel-local angle (3π/2 − rotation) mod 2π (see
    // getWinningIndex). Solve rotation so that equals the segment's centre.
    const targetMod = (((3 * Math.PI / 2 - segCenter) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const current = rotationRef.current;
    const currentMod = ((current % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    let delta = targetMod - currentMod;
    if (delta > Math.PI) delta -= 2 * Math.PI;       // shortest direction
    if (delta < -Math.PI) delta += 2 * Math.PI;
    if (Math.abs(delta) < 0.0005) {
      // Already in place — but if the freeze above left a cheap motion bake
      // (grabbed mid-spin), re-quantize the now-resting frame.
      if (restBakeFastRef.current) paint();
      updateCurrentSegment();
      return;
    }

    // Compositor CSS transition, like the tap-spin/decay, instead of the old
    // per-frame re-bake rAF loop. This animation runs exactly when a segment
    // tap ALSO opens the editor sheet and CSS-scales the wheel container —
    // re-baking every frame there re-uploaded the canvas texture into an
    // animating layer while React mounted the sheet (the tap-flow jank). Bake
    // ONCE at the target orientation and unwind the transform to rest.
    const duration = 450;
    const endRot = current + delta;
    rotationRef.current = endRot;
    paint();                          // full-quality bake at the target; transform cleared
    const rotor = rotorRef.current;
    if (!rotor) { updateCurrentSegment(); return; }
    gpuSpinActiveRef.current = true;  // guards stray paints; cancelInFlight re-freezes exactly
    rotor.style.transition = 'none';
    rotor.style.transform = `rotate(${-delta}rad) translateZ(0)`;
    void rotor.offsetWidth;           // commit the start-offset state
    requestAnimationFrame(() => {
      if (!gpuSpinActiveRef.current) return; // cancelled before it began
      rotor.style.transition = `transform ${duration}ms ${EASE_IN_OUT_CSS}`;
      rotor.style.transform = 'rotate(0rad) translateZ(0)';
    });
    // Read-only header tracker (no canvas work): mirrors the easing so the
    // header still ticks through intermediate segments, then settles. The
    // +50ms grace covers the one-frame-late CSS start; the ease ends flat, so
    // any residual angle at settle is sub-pixel.
    const startTime = performance.now();
    const tick = (now: number) => {
      if (!gpuSpinActiveRef.current) return; // interrupted (grab / new animation)
      const t = Math.min(1, (now - startTime) / duration);
      const seg = segmentAtRotation(current + delta * easeInOut(t));
      if (seg !== lastRenderedSegmentRef.current) {
        lastRenderedSegmentRef.current = seg;
        setCurrentSegment(seg);
      }
      if (now - startTime < duration + 50) {
        headerRafRef.current = requestAnimationFrame(tick);
      } else {
        gpuSpinActiveRef.current = false;
        paint();                      // commit the rest frame (un-promotes the layer)
      }
    };
    headerRafRef.current = requestAnimationFrame(tick);
  }, [items, cancelInFlight, paint, updateCurrentSegment, segmentAtRotation]);

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
  // True if the win-overlay END animation was playing at the last pointerdown —
  // a plain tap (no drag) then just STOPS it (like a drag does) instead of
  // launching a fresh spin. A tap on a LIVE spin still restarts the spin.
  const tappedToStopRef = useRef(false);
  // A stationary tap on a wedge fires onSegmentLongPress (the segment action) and
  // no longer spins; spinning is via the SPIN button (or a flick/drag). In play
  // mode — where no segment action is wired — a tap still spins. See
  // handlePointerUp. (Kept the prop name for compatibility with callers.)

  // Compute which segment index a screen-coords tap landed on. Inverts the
  // canvas rotation so the angle is in segment-local coords, then walks the
  // weighted segments to find the containing wedge.
  const segmentIndexAtPos = useCallback((clientX: number, clientY: number,
                                          centerX: number, centerY: number): number => {
    const screenAngle = Math.atan2(clientY - centerY, clientX - centerX);
    let localAngle = screenAngle - rotationRef.current;
    localAngle = ((localAngle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const totalWeight = items.reduce((s, item) => s + item.weight, 0);
    if (totalWeight <= 0) return 0;
    const arcSize = (2 * Math.PI) / totalWeight;
    let accumulated = 0;
    for (let i = 0; i < items.length; i++) {
      const segStart = accumulated * arcSize;
      accumulated += items[i].weight;
      const segEnd = accumulated * arcSize;
      if (localAngle >= segStart && localAngle < segEnd) return i;
    }
    return items.length - 1;
  }, [items]);
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
  // Hard cap on accumulated post-release velocity. ~67 clicks/sec on a
  // 12-segment wheel — still inside WebAudio's comfort zone but high
  // enough that aggressive flicks have meaningful headroom.
  const MAX_VELOCITY = 0.035;
  // Velocity added by pressing SPIN while the wheel is already in motion —
  // roughly one mid-intensity button-spin's mean speed. Repeated presses
  // accumulate toward MAX_VELOCITY, the same ceiling every spin source has.
  const SPIN_PRESS_BOOST = 0.012; // rad/ms

  // (cancelInFlight + playWinOverlay are declared before spin() so that
  // spin's useCallback can include playWinOverlay in its deps.)

  // ── Stillness commit ──
  // While a pointer HOLDS the wheel visually still (a paused drag, or a tap
  // pinning a wheel that was frozen mid-motion), commit ONE full-quality,
  // screen-aligned bake after a short quiet period. Any noticeable rotation
  // re-arms the timer, so a wheel that keeps moving never re-bakes — quality is
  // only restored when the user actually stops. Skips entirely when nothing is
  // owed (bitmap already quantized and at identity transform).
  const STILL_COMMIT_MS = 25;
  // Rotation across a whole quiet window that still counts as "still". Judged
  // per WINDOW, not per pointer event — a per-event delta threshold reads any
  // slow drag as stillness (event rate ≫ motion rate) and committed mid-drag,
  // which was a visible periodic hitch (bake + layer re-promote). Scaled to
  // the window so the speed cutoff stays put when the window is retuned.
  const STILL_EPS = 0.08 * (STILL_COMMIT_MS / 1000); // ≈ 0.08 rad/s
  const stillTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Timestamp of the last drag pointermove — the second stillness signal. A
  // finger that keeps dragging (any speed) streams move events continuously; a
  // resting finger goes quiet. Requiring BOTH quiet events AND a quiet rotation
  // window makes a mid-drag commit (a bake + layer re-promote = visible frame
  // skip) impossible while the user is actively moving.
  const lastDragMoveTsRef = useRef(0);
  const armStillCommit = useCallback(() => {
    if (stillTimerRef.current) clearTimeout(stillTimerRef.current);
    const armRotation = rotationRef.current;
    stillTimerRef.current = setTimeout(() => {
      stillTimerRef.current = null;
      if (!dragRef.current) return; // released — the settle paths own the commit
      // Watch the next window if the pointer or wheel is still active, or if
      // nothing is owed yet (it may move again and stop again later).
      const eventsQuiet = performance.now() - lastDragMoveTsRef.current >= STILL_COMMIT_MS * 0.8;
      if (!eventsQuiet || Math.abs(rotationRef.current - armRotation) > STILL_EPS) { armStillCommit(); return; }
      const t = rotorRef.current?.style.transform;
      const hasOffset = !!t && t !== 'none';
      if (restBakeFastRef.current || hasOffset) paint(); // crisp, aligned commit
      armStillCommit();
    }, STILL_COMMIT_MS);
  }, [paint]);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button === 2) return;
    // Was the win-overlay END animation playing when grabbed? If so a plain tap
    // just stops it; a tap on a LIVE spin still restarts the spin as usual.
    // Captured before the cancels below clear that state.
    tappedToStopRef.current = winOverlayActiveRef.current;
    // Grab interrupts an in-flight win flash — fade it out gracefully
    // from its current opacity rather than letting it sit on top of
    // the user's drag.
    cancelWinOverlay();
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
    // A grab that just froze a moving wheel holds a cheap (fast-baked) frame;
    // if the pointer then rests, this commits it crisp after the quiet period.
    armStillCommit();
  }, [cancelInFlight, segmentAtRotation, armStillCommit]);

  // Live drag: rotate the ROTOR via its CSS transform — exactly like the
  // tap-spin/decay — with ZERO canvas re-bakes while the finger is down. The
  // bitmap stays baked at bakedRotationRef and the per-frame transform supplies
  // the drag offset, so per-move cost is one compositor-cheap style write
  // (coalesced to one per rAF; high-Hz pointers deliver several moves per
  // display frame). The pixel blocks rotate off the screen grid mid-drag, but
  // that is already the accepted look during CSS-driven spins; every release
  // path ends in a full-quality paint() that re-quantizes screen-aligned.
  // (The historical per-move BITMAP repaint was the drag lag: full vector
  // redraw + pixelate per pointermove. Its stutter note about transforms was
  // about repainting WHILE layer-promoted — re-uploading the texture each
  // frame — which transform-only dragging never does.)
  const dragPaintRafRef = useRef(0);
  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;

    if (!drag.crossedThreshold) {
      const dx = e.clientX - drag.startClientPos.x;
      const dy = e.clientY - drag.startClientPos.y;
      if (Math.hypot(dx, dy) < 6) return; // still might be a tap
      drag.crossedThreshold = true;
      // Kill any stale transition once for the whole drag — the rAF below then
      // only writes `transform` per frame. (paint() also resets transition, so
      // a mid-drag stillness commit re-establishes this invariant itself.)
      const c = rotorRef.current;
      if (c) c.style.transition = 'none';
    }
    lastDragMoveTsRef.current = performance.now();

    // Pointer angle around the wheel centre; the delta since last event is how
    // far the wheel rotated under the finger.
    const angle = Math.atan2(e.clientY - drag.centerScreen.y, e.clientX - drag.centerScreen.x);
    let delta = angle - drag.lastPointerAngle;
    if (delta > Math.PI) delta -= 2 * Math.PI;
    if (delta < -Math.PI) delta += 2 * Math.PI;
    drag.lastPointerAngle = angle;
    rotationRef.current += delta;

    const seg = segmentAtRotation(rotationRef.current);
    if (seg !== drag.lastRenderedSegment) {
      drag.lastRenderedSegment = seg;
      lastRenderedSegmentRef.current = seg;
      if (headerTextRef.current) headerTextRef.current.textContent = seg;
      playTickInline(tickFnRef.current);
    }

    // Keep the last ~80ms of samples for release-velocity computation.
    const now = performance.now();
    drag.samples.push({ time: now, rotation: rotationRef.current });
    while (drag.samples.length > 1 && now - drag.samples[0].time > 80) drag.samples.shift();

    if (!dragPaintRafRef.current) {
      dragPaintRafRef.current = requestAnimationFrame(() => {
        dragPaintRafRef.current = 0;
        // Released before this frame fired → the pointer-up settle/decay logic
        // already owns the transform; don't clobber it.
        if (!dragRef.current) return;
        const c = rotorRef.current;
        // translateZ(0) promotes the rotor to its own layer for the drag
        // (one texture upload on the first frame, compositor-only after) —
        // the same self-promotion the tap/decay transforms use. transition
        // was cleared once at threshold-crossing; only transform per frame.
        if (c) c.style.transform = `rotate(${rotationRef.current - bakedRotationRef.current}rad) translateZ(0)`;
      });
    }
  }, [segmentAtRotation]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
    // Drop any pending coalesced drag bake + stillness commit — the settle
    // logic below owns the canvas from here (their dragRef guards also cover a
    // raced firing).
    cancelAnimationFrame(dragPaintRafRef.current);
    dragPaintRafRef.current = 0;
    if (stillTimerRef.current) { clearTimeout(stillTimerRef.current); stillTimerRef.current = null; }
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch {}

    // The header was written straight to the DOM during the drag; sync React
    // state to it now so later renders keep the correct text.
    if (drag.crossedThreshold) setCurrentSegment(lastRenderedSegmentRef.current);

    if (!drag.crossedThreshold) {
      // A tap that interrupted the END animation just stops it (already
      // cancelled on pointerdown) — the wheel is now at rest, so if the grab
      // froze it with a cheap motion bake, re-quantize before leaving it.
      if (tappedToStopRef.current) {
        if (restBakeFastRef.current) paint();
        return;
      }
      if (onSegmentLongPress) {
        // Stationary tap → open the tapped wedge's segment action (it no longer
        // spins; spinning is via the SPIN button or a flick).
        const idx = segmentIndexAtPos(drag.startClientPos.x, drag.startClientPos.y, drag.centerScreen.x, drag.centerScreen.y);
        onSegmentLongPress(idx);
      } else {
        // No segment action wired (play mode) → a tap still spins.
        spin();
      }
      return;
    }

    // Release velocity: angular distance over the last sample window.
    // The move handler trims samples to the last 80ms — but it only runs
    // on pointer-move. If the user stops moving but keeps the finger
    // down, no new samples come in and the buffer freezes on whatever
    // was there last (potentially seconds-old motion). So:
    //   (a) re-trim at release time using the CURRENT clock, and
    //   (b) if the most recent sample is older than the window itself,
    //       the user wasn't actually moving on release — velocity = 0.
    const SAMPLE_WINDOW_MS = 80;
    const now = performance.now();
    while (drag.samples.length > 1 && now - drag.samples[0].time > SAMPLE_WINDOW_MS) {
      drag.samples.shift();
    }
    let dragVelocity = 0;
    if (drag.samples.length >= 2) {
      const last = drag.samples[drag.samples.length - 1];
      if (now - last.time <= SAMPLE_WINDOW_MS) {
        const first = drag.samples[0];
        const dt = last.time - first.time;
        if (dt > 0) dragVelocity = (last.rotation - first.rotation) / dt;
      }
    }
    // RELEASE_BOOST is applied ONLY to the new drag input; the carried velocity
    // from a re-grabbed decay is added at face value.
    //
    // Carry the pre-grab momentum ONLY when the release drag continues in the
    // SAME direction (a re-flick that accumulates / winds the wheel up). When the
    // drag goes the OPPOSITE way the user is braking or reversing — but a small
    // reverse nudge's `dragVelocity * BOOST` can't outweigh a large carry, so the
    // carry wins and the wheel springs back to its original direction (the "small
    // backward swipe bounces back" bug). Dropping the carry there lets even a tiny
    // reverse drag register. A zero drag (grabbed and held still on release) drops
    // it too — that's a grab-to-stop.
    const RELEASE_BOOST = 2;
    const sameDirection = dragVelocity !== 0 && Math.sign(dragVelocity) === Math.sign(drag.carriedVelocity);
    const carried = sameDirection ? drag.carriedVelocity : 0;
    let velocity = dragVelocity * RELEASE_BOOST + carried;
    if (velocity > MAX_VELOCITY) velocity = MAX_VELOCITY;
    else if (velocity < -MAX_VELOCITY) velocity = -MAX_VELOCITY;

    // No spin → just leave the wheel where the user dropped it. Commit the
    // dragged rotation into the bitmap and exit transform mode.
    if (Math.abs(velocity) < STOP_VELOCITY) {
      gpuSpinActiveRef.current = false;
      paint();
      return;
    }

    launchDecay(velocity);
  }, [spin, paint, launchDecay, onSegmentLongPress, segmentIndexAtPos]);

  const handlePointerCancel = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
    // Drop any pending coalesced drag bake + stillness commit — the settle
    // logic below owns the canvas from here (their dragRef guards also cover a
    // raced firing).
    cancelAnimationFrame(dragPaintRafRef.current);
    dragPaintRafRef.current = 0;
    if (stillTimerRef.current) { clearTimeout(stillTimerRef.current); stillTimerRef.current = null; }
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch {}
    // If we were dragging via the element transform, commit it into the bitmap.
    if (gpuSpinActiveRef.current) {
      gpuSpinActiveRef.current = false;
      paint();
    } else if (drag.crossedThreshold) {
      // The drag frames baked with the fast pixelate; settle on a quantized bake.
      paint();
    }
  }, [paint]);

  useImperativeHandle(ref, () => ({
    spin,
    reset,
    focusSegment,
    get isSpinning() { return isSpinningRef.current; },
  }), [spin, reset, focusSegment]);

  // Cleanup animations + audio on unmount — cancels both the spin/decay
  // slot AND the win-overlay slot, plus the hold-timer between fade-in
  // and fade-out, so nothing leaks into the next mount. Also stops any
  // scheduled click sources still queued on the audio thread; without
  // this, switching to a different preview tile mid-spin (which keys
  // the wheel canvas wrapper to remount on block.id change) would
  // unmount SpinningWheel but the WebAudio queue would keep firing
  // ticks for the wheel that's no longer on screen.
  useEffect(() => {
    return () => {
      cancelAnimationFrame(animRef.current);
      cancelAnimationFrame(winAnimRef.current);
      cancelAnimationFrame(headerRafRef.current);
      gpuSpinActiveRef.current = false;
      if (winHoldTimerRef.current) clearTimeout(winHoldTimerRef.current);
      for (const s of scheduledSourcesRef.current) {
        try { s.stop(); } catch {}
      }
      scheduledSourcesRef.current = [];
    };
  }, []);

  // Result dialog dismissal: close it and let the (paused) win flash fade out.
  const dismissResult = () => {
    setResultText(null);
    cancelWinOverlay();
  };
  // "Spin again": kill the win flash outright (next paint clears it) and re-spin.
  const spinAgainFromResult = () => {
    cancelAnimationFrame(winAnimRef.current);
    if (winHoldTimerRef.current) { clearTimeout(winHoldTimerRef.current); winHoldTimerRef.current = null; }
    overlayOpacityRef.current = 0;
    winningIndexRef.current = -1;
    winOverlayActiveRef.current = false;
    if (winHoldTimerRef.current) { clearTimeout(winHoldTimerRef.current); winHoldTimerRef.current = null; }
    if (dimCanvasRef.current) { dimCanvasRef.current.style.transition = 'none'; dimCanvasRef.current.style.opacity = '0'; }
    setResultText(null);
    spin();
  };

  const headerFontSize = 56 * headerTextSizeMultiplier;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      {/* Segment header — in flow above the canvas so the (header + canvas)
          group acts as a unit when the parent centers this component. */}
      <div style={{
        opacity: headerOpacity,
        transform: `scale(${headerSizeProgress})`,
        transformOrigin: 'center bottom',
        height: (headerFontSize + size * 0.015) * headerSizeProgress,
        display: 'flex',
        // alignItems: 'flex-start' pushes the text to the top of the
        // header box — kills the upper padding without changing the
        // box's overall height or any other wheel sizing. All of the
        // size*0.015 padding now sits below the text instead of split
        // evenly above and below.
        alignItems: 'flex-start',
        justifyContent: 'center',
        willChange: 'transform, height, opacity',
        transition: headerTransition,
      }}>
        <div ref={headerTextRef} style={{
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

      <div style={{ height: headerCanvasGap * headerSizeProgress, transition: headerTransition }} />

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
        {/* Rotor — the spin/decay transforms rotate THIS, so the art + text
            canvases turn together. The marker below is its sibling, so it
            doesn't rotate. */}
        <div ref={rotorRef} style={{ position: 'relative', width: size, height: size }}>
          <canvas
            ref={canvasRef}
            // No persistent will-change: the live drag repaints the bitmap each
            // move, and a forced compositor layer would re-upload the texture
            // every frame. The tap/decay CSS transitions promote a layer on their
            // own (via translateZ(0) in their transforms) only while animating.
            // Pixelate mode: force nearest-neighbour sampling so the GPU keeps the
            // baked blocks crisp through the CSS-rotate spin + dpr downscale
            // instead of bilinear-smoothing them back into AA. Labels live on the
            // separate smooth canvas above, so this never jags text.
            style={{ width: size, height: size, display: 'block', imageRendering: PIXEL_SCALE > 1 ? 'pixelated' : undefined }}
          />
          {PIXEL_SCALE > 1 && (
            <canvas
              ref={textCanvasRef}
              // Smooth (default image-rendering) overlay carrying only the crisp
              // labels + per-slice visuals, aligned exactly over the art canvas.
              style={{ position: 'absolute', top: 0, left: 0, width: size, height: size, display: 'block', pointerEvents: 'none' }}
            />
          )}
          {/* Win DIM layer — dark mask (winner punched out) composited over the
              baked wheel + labels, faded via CSS opacity. Starts invisible. */}
          <canvas
            ref={dimCanvasRef}
            style={{
              position: 'absolute', top: 0, left: 0, width: size, height: size, display: 'block',
              pointerEvents: 'none', opacity: 0, willChange: 'opacity',
              imageRendering: PIXEL_SCALE > 1 ? 'pixelated' : undefined,
            }}
          />
        </div>
        {/* Center marker */}
        <div style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          pointerEvents: 'none',
        }}>
          {/* Pixelate mode uses the canvas marker so the centre matches the
              wheel's lo-fi look. The pin (default off) isn't ported to canvas
              yet, so fall back to the SVG marker when it's on. */}
          {PIXEL_SCALE > 1 && !showPin ? (
            <PixelatedMarker
              size={size * (250 / 700)}
              markerDiameter={markerDiameter}
              markerPeek={markerPeek}
              markerBaseColor={markerBaseColor}
              roughSeed={roughSeed}
            />
          ) : (
            <CustomMarker
              size={size * (250 / 700)}
              markerDiameter={markerDiameter}
              markerPeek={markerPeek}
              markerBaseColor={markerBaseColor}
              roughSeed={roughSeed}
              showPin={showPin}
            />
          )}
        </div>
      </div>

      <div style={{ height: 16 * (0.5 + 0.5 * headerSizeProgress), transition: headerTransition }} />

      {/* Celebration + result dialog are PORTALED to <body>: the wheel can sit
          inside a transformed/scaled ancestor (e.g. the editor preview), which
          would otherwise make these position:fixed layers relative to that
          ancestor instead of the viewport — scaling/hiding them. */}
      {resultDialog && typeof document !== 'undefined' && createPortal(
        <>
          {/* Dot celebration overlay (fires as the win overlay fades out). */}
          <DotCelebration ref={celebrationRef} />

          {/* Result dialog — shown just as the win overlay begins fading out. */}
          {resultText !== null && (
        <div
          onPointerDown={(e) => { if (e.target === e.currentTarget) dismissResult(); }}
          style={{
            position: 'fixed', inset: 0, zIndex: 10000, padding: 24,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(20, 16, 40, 0.55)',
          }}
        >
          <style>{'@keyframes dotResultPop{from{opacity:0;transform:scale(.85) translateY(8px)}to{opacity:1;transform:none}}'}</style>
          <div style={{
            width: '100%', maxWidth: 340, background: '#fff', borderRadius: 26,
            boxShadow: '0 24px 70px rgba(0,0,0,0.35)', padding: '30px 24px', textAlign: 'center',
            animation: 'dotResultPop .34s cubic-bezier(.2,1.4,.4,1)',
          }}>
            <div style={{ fontSize: 52, lineHeight: 1 }}>🎉</div>
            <div style={{ marginTop: 8, color: '#9b93bd', fontWeight: 700, fontSize: 12, letterSpacing: 1, textTransform: 'uppercase' }}>
              It landed on
            </div>
            <div style={{ marginTop: 6, fontSize: 30, fontWeight: 800, color: '#241a40', lineHeight: 1.15, wordBreak: 'break-word' }}>
              {resultText}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 24 }}>
              <button
                onClick={spinAgainFromResult}
                style={{ height: 50, borderRadius: 999, border: 'none', cursor: 'pointer', fontSize: 16, fontWeight: 700, color: '#fff', background: '#7b5cff' }}
              >
                Spin again
              </button>
              <button
                onClick={dismissResult}
                style={{ height: 50, borderRadius: 999, border: 'none', cursor: 'pointer', fontSize: 16, fontWeight: 700, color: '#6b6688', background: '#f0eef7' }}
              >
                Done
              </button>
            </div>
          </div>
        </div>
          )}
        </>,
        document.body,
      )}
    </div>
  );
});

SpinningWheel.displayName = 'SpinningWheel';
export default SpinningWheel;
