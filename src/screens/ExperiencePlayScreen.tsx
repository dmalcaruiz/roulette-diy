import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { getDraft } from '../services/blockService';
import { getPublishedExperience } from '../services/publishedExperienceService';
import { recordPlayResult } from '../services/resultService';
import SpinningWheel, { type SpinningWheelHandle } from '../components/SpinningWheel';
import { ON_SURFACE, PRIMARY } from '../utils/constants';
import { withAlpha } from '../utils/colorUtils';
import { PushDownButton } from '../components/PushDownButton';
import type { ExperienceStep, WheelConfig, ListRandomizerConfig } from '../models/types';
import type { PublishedStepBlock } from '../types/experience';
import { ArrowLeft, RotateCcw, Loader2 } from 'lucide-react';

// Chromeless renderer for an Experience flow. Designed to be droppable into
// OBS as a browser source — no nav bar, no header, optional transparent
// background via ?bg=transparent.
//
//   roulette.diy/e/{publishedId}/play              — public, no auth
//   roulette.diy/e/{publishedId}/play?bg=transparent — for OBS overlay
//   roulette.diy/e/{publishedId}/play?auto=1        — spins automatically
//
// We try public published_experiences/{id} first (works for everyone). If
// that fails AND the current user has a draft with this id, we play their
// own draft — useful for previewing in OBS before publishing.

interface PlayableExperience {
  id: string;
  name: string;
  steps: ExperienceStep[];
  stepBlocks: PublishedStepBlock[];
  isPublished: boolean;
}

export default function ExperiencePlayScreen() {
  const { id } = useParams<{ id: string }>();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const { user, authLoading } = useAuth();

  const [exp, setExp] = useState<PlayableExperience | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [history, setHistory] = useState<{ stepBlockId: string; resultText: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const wheelRef = useRef<SpinningWheelHandle>(null);
  const transparent = search.get('bg') === 'transparent';
  const autoStart = search.get('auto') === '1';

  // 1. Try the public collection — works without auth, intended path.
  // 2. Fall back to the current user's drafts — owner-preview path.
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const published = await getPublishedExperience(id);
        if (cancelled) return;
        if (published) {
          setExp({
            id: published.id,
            name: published.name,
            steps: published.steps,
            stepBlocks: published.stepBlocks,
            isPublished: true,
          });
          setLoading(false);
          return;
        }

        // Fallback: owner-preview from drafts.
        if (authLoading) return; // wait for auth state, useEffect re-runs
        if (!user) {
          setError('This Experience is not published yet.');
          setLoading(false);
          return;
        }
        const draft = await getDraft(user.uid, id);
        if (cancelled) return;
        if (!draft || draft.type !== 'experience') {
          setError('Experience not found.');
          setLoading(false);
          return;
        }
        const draftSteps = draft.experienceConfig?.steps ?? [];
        const resolved = await Promise.all(draftSteps.map(s => getDraft(user.uid, s.blockId)));
        if (cancelled) return;
        const stepBlocks: PublishedStepBlock[] = [];
        for (const b of resolved) {
          if (!b) continue;
          if (b.type === 'roulette' && b.wheelConfig) {
            stepBlocks.push({ type: 'roulette', id: b.id, name: b.name, wheelConfig: b.wheelConfig });
          } else if (b.type === 'listRandomizer' && b.listConfig) {
            stepBlocks.push({ type: 'listRandomizer', id: b.id, name: b.name, listConfig: b.listConfig });
          }
        }
        setExp({
          id: draft.id,
          name: draft.name,
          steps: draftSteps,
          stepBlocks,
          isPublished: false,
        });
        setLoading(false);
      } catch (e) {
        if (!cancelled) {
          console.error('Failed to load Experience for play:', e);
          setError('Failed to load Experience.');
          setLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [id, user, authLoading]);

  // Find the next step to advance to. Conditions are evaluated against the
  // result text: a step with `conditionSegment === resultText` is taken; if
  // none match, fall back to the next step with no condition. If nothing
  // matches, the flow ends.
  const advance = (resultText: string) => {
    if (!exp) return;
    const currentBlockId = exp.stepBlocks[stepIndex]?.id ?? '';
    const newHistory = [...history, { stepBlockId: currentBlockId, resultText }];
    setHistory(newHistory);

    let next = -1;
    for (let i = stepIndex + 1; i < exp.steps.length; i++) {
      const cond = exp.steps[i].conditionSegment ?? null;
      if (cond === null || cond === resultText) {
        next = i;
        break;
      }
    }
    if (next === -1) {
      recordPlayResult({
        experienceId: exp.id,
        isPublished: exp.isPublished,
        experienceName: exp.name,
        steps: newHistory,
      }).catch(e => console.error('recordPlayResult failed:', e));
      setStepIndex(exp.steps.length); // sentinel: past the end
      return;
    }
    setStepIndex(next);
  };

  const restart = () => {
    setStepIndex(0);
    setHistory([]);
  };

  // Auto-spin on each step if requested.
  useEffect(() => {
    if (!autoStart || !exp) return;
    const t = setTimeout(() => {
      wheelRef.current?.spin();
    }, 500);
    return () => clearTimeout(t);
  }, [autoStart, stepIndex, exp]);

  const bgColor = transparent ? 'transparent' : '#FFFFFF';

  if (loading) {
    return (
      <Centered bg={bgColor}>
        <Loader2 size={32} color={PRIMARY} className="spin" />
      </Centered>
    );
  }
  if (error) return <Centered bg={bgColor}><Message>{error}</Message></Centered>;
  if (!exp) return <Centered bg={bgColor}><Message>Experience not found.</Message></Centered>;
  if (exp.steps.length === 0 || exp.stepBlocks.length === 0) {
    return <Centered bg={bgColor}><Message>This Experience has no steps yet.</Message></Centered>;
  }

  // Flow finished
  if (stepIndex >= exp.steps.length) {
    return (
      <Centered bg={bgColor}>
        <h2 style={{ fontSize: 26, fontWeight: 800, color: ON_SURFACE, margin: '0 0 14px' }}>
          Done!
        </h2>
        <div style={{ marginBottom: 22 }}>
          {history.map((h, i) => (
            <div key={i} style={{ fontSize: 15, color: withAlpha(ON_SURFACE, 0.7), margin: '4px 0' }}>
              {i + 1}. {h.resultText}
            </div>
          ))}
        </div>
        <PushDownButton color={PRIMARY} onTap={restart}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#FFF', padding: '0 18px' }}>
            <RotateCcw size={18} />
            <span style={{ fontWeight: 700 }}>Play again</span>
          </div>
        </PushDownButton>
      </Centered>
    );
  }

  // Map stepIndex (in `steps`) to stepBlocks index. Today these are 1:1 in
  // both the published snapshot and the draft fallback, so a simple lookup
  // by position works.
  const currentBlock = exp.stepBlocks[stepIndex];
  if (!currentBlock) {
    return <Centered bg={bgColor}><Message>Step is missing or was deleted.</Message></Centered>;
  }

  if (currentBlock.type === 'roulette') {
    const cfg: WheelConfig = currentBlock.wheelConfig;
    const items = cfg.items;
    return (
      <Stage bg={bgColor}>
        <BackButton hidden={transparent} onClick={() => navigate(-1)} />
        <div style={{ position: 'relative', width: 'min(90vmin, 600px)', aspectRatio: '1 / 1' }}>
          <SpinningWheel
            ref={wheelRef}
            items={items}
            size={Math.min(window.innerWidth * 0.9, 600)}
            textSizeMultiplier={cfg.textSize}
            headerTextSizeMultiplier={cfg.headerTextSize}
            imageSize={cfg.imageSize}
            cornerRadius={cfg.cornerRadius}
            innerCornerStyle={cfg.innerCornerStyle}
            centerInset={cfg.centerInset}
            strokeWidth={cfg.strokeWidth}
            showBackgroundCircle={cfg.showBackgroundCircle}
            centerMarkerSize={cfg.centerMarkerSize}
            onFinished={(idx) => advance(items[idx]?.text ?? '')}
          />
        </div>
        <div style={{ marginTop: 24 }}>
          <PushDownButton color={PRIMARY} onTap={() => wheelRef.current?.spin()}>
            <span style={{ color: '#FFF', fontWeight: 700, fontSize: 16, padding: '0 28px' }}>
              SPIN
            </span>
          </PushDownButton>
        </div>
      </Stage>
    );
  }

  if (currentBlock.type === 'listRandomizer') {
    const lcfg: ListRandomizerConfig = currentBlock.listConfig;
    return (
      <Stage bg={bgColor}>
        <BackButton hidden={transparent} onClick={() => navigate(-1)} />
        <h2 style={{ fontSize: 22, fontWeight: 800, color: ON_SURFACE, margin: '0 0 14px' }}>
          {currentBlock.name}
        </h2>
        <PushDownButton color={PRIMARY} onTap={() => {
          const picks = lcfg.categories.map(c =>
            c.options[Math.floor(Math.random() * c.options.length)] ?? ''
          );
          advance(picks.join(' • '));
        }}>
          <span style={{ color: '#FFF', fontWeight: 700, fontSize: 16, padding: '0 28px' }}>
            Randomize
          </span>
        </PushDownButton>
      </Stage>
    );
  }

  return <Centered bg={bgColor}><Message>Unsupported step type.</Message></Centered>;
}

// ── Layout primitives ──────────────────────────────────────────────────────

function Stage({ bg, children }: { bg: string; children: React.ReactNode }) {
  return (
    <div style={{
      width: '100vw',
      height: '100dvh',
      backgroundColor: bg,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 16,
    }}>
      {children}
    </div>
  );
}

function Centered({ bg, children }: { bg: string; children: React.ReactNode }) {
  return (
    <div style={{
      width: '100vw',
      height: '100dvh',
      backgroundColor: bg,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexDirection: 'column',
      padding: 24,
      textAlign: 'center',
    }}>
      {children}
    </div>
  );
}

function Message({ children }: { children: React.ReactNode }) {
  return (
    <p style={{ fontSize: 15, color: withAlpha(ON_SURFACE, 0.6), margin: 0 }}>{children}</p>
  );
}

function BackButton({ onClick, hidden }: { onClick: () => void; hidden?: boolean }) {
  if (hidden) return null;
  return (
    <button
      onClick={onClick}
      style={{
        position: 'fixed',
        top: 16,
        left: 16,
        padding: 10,
        borderRadius: 999,
        border: 'none',
        backgroundColor: withAlpha(ON_SURFACE, 0.06),
        cursor: 'pointer',
      }}
      aria-label="Back"
    >
      <ArrowLeft size={20} color={ON_SURFACE} />
    </button>
  );
}
