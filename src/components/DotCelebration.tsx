import { forwardRef, useImperativeHandle, useRef, useEffect } from 'react';

interface Particle {
  x: number; y: number; vx: number; vy: number;
  g: number; size: number; color: string; life: number;
}

export interface DotCelebrationHandle {
  /** Fire a burst of celebratory dots in the given colours from the upper centre. */
  burst: (colors: string[]) => void;
}

// Full-screen dot-confetti overlay (ported from the Spinly reference, dots only
// to match the wheel's bezel-dot motif). Imperative: hold a ref and call
// burst(colors). Self-managing rAF; the canvas is fixed + pointer-events:none so
// it never blocks the UI and only paints while particles are alive.
const DotCelebration = forwardRef<DotCelebrationHandle>((_props, ref) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const particlesRef = useRef<Particle[]>([]);
  const rafRef = useRef<number>(0);

  const loop = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) { rafRef.current = 0; return; }
    const W = window.innerWidth, H = window.innerHeight;
    ctx.clearRect(0, 0, W, H);
    const ps = particlesRef.current;
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i];
      p.vy += p.g; p.vx *= 0.99;
      p.x += p.vx; p.y += p.vy;
      if (p.y > H * 0.62) p.life -= 0.02;
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size / 2, 0, Math.PI * 2);
      ctx.fill();
      if (p.life <= 0 || p.y > H + 40) ps.splice(i, 1);
    }
    ctx.globalAlpha = 1;
    if (ps.length) {
      rafRef.current = requestAnimationFrame(loop);
    } else {
      ctx.clearRect(0, 0, W, H);
      rafRef.current = 0;
    }
  };

  // Keep the canvas sized to the viewport (DPR-aware).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(window.innerWidth * dpr);
      canvas.height = Math.round(window.innerHeight * dpr);
      canvas.style.width = window.innerWidth + 'px';
      canvas.style.height = window.innerHeight + 'px';
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('resize', resize);
      cancelAnimationFrame(rafRef.current);
    };
  }, []);

  useImperativeHandle(ref, () => ({
    burst(colors: string[]) {
      const canvas = canvasRef.current;
      if (!canvas || colors.length === 0) return;
      const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      const W = window.innerWidth, H = window.innerHeight;
      const ox = W / 2, oy = H * 0.35;
      const count = reduced ? 44 : 280;
      for (let i = 0; i < count; i++) {
        const ang = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.05;
        const sp = 7 + Math.random() * 13;
        particlesRef.current.push({
          x: ox + (Math.random() - 0.5) * 140,
          y: oy,
          vx: Math.cos(ang) * sp,
          vy: Math.sin(ang) * sp - Math.random() * 4,
          g: 0.22 + Math.random() * 0.1,
          size: 5 + Math.random() * 8,
          color: colors[Math.floor(Math.random() * colors.length)],
          life: 1,
        });
      }
      if (!rafRef.current) rafRef.current = requestAnimationFrame(loop);
    },
  }), []);

  return (
    <canvas
      ref={canvasRef}
      style={{ position: 'fixed', inset: 0, zIndex: 10050, pointerEvents: 'none' }}
    />
  );
});

DotCelebration.displayName = 'DotCelebration';
export default DotCelebration;
