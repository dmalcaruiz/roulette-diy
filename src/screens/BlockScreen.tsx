import { useState, useRef, useCallback, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Block } from '../models/types';
import RouletteScreen from './RouletteScreen';
import SpinningWheel, { type SpinningWheelHandle } from '../components/SpinningWheel';
import { PushDownButton, InsetTextField } from '../components/PushDownButton';
import { ON_SURFACE, BORDER, PRIMARY } from '../utils/constants';
import { withAlpha } from '../utils/colorUtils';
import { useAuth } from '../contexts/AuthContext';
import { publishWheel, unpublishWheel, syncPublishedWheel } from '../services/publishService';
import { uploadImage } from '../services/uploadService';
import { getDraft, type CloudBlock } from '../services/blockService';
import { loadFlowStepBlocks } from '../services/flowService';
import { dbg, sid, sids } from '../utils/debugLog';
import { doc, setDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebase';
import {
  ArrowLeft, Pencil, Trophy, CheckCircle, Circle, ImageIcon, Shuffle, Sparkles,
  Share2, Lock, Trash2, Tag, FileText, Loader2,
} from 'lucide-react';

interface BlockScreenProps {
  onBlockUpdated?: (block: Block) => void;
}

// Full navigation payload. `flowExperience` / `flowSteps` are optional —
// passed by callers that already have them in memory (the `+` handler or the
// preview-tile tap) so the next screen can render without a Firestore round-trip.
interface BlockRouteState {
  block: Block;
  editMode: boolean;
  flowExperience?: CloudBlock;
  flowSteps?: CloudBlock[];
}

export default function BlockScreen({ onBlockUpdated }: BlockScreenProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const state = location.state as BlockRouteState | null;
  const { user } = useAuth();

  const [block, setBlock] = useState<Block | null>(state?.block ?? null);
  const [showEditor, setShowEditor] = useState(state?.editMode ?? false);
  const [flowSteps, setFlowStepsRaw] = useState<CloudBlock[] | undefined>(state?.flowSteps);
  const [flowExperience, setFlowExperienceRaw] = useState<CloudBlock | undefined>(state?.flowExperience);
  const wheelRef = useRef<SpinningWheelHandle>(null);

  // Wrapped setters — log every transition with caller stack so we can see
  // exactly who triggered a flow-state mutation.
  const setFlowSteps = useCallback((next: CloudBlock[] | undefined, tag: string) => {
    setFlowStepsRaw(prev => {
      const prevLen = prev?.length ?? 0;
      const nextLen = next?.length ?? 0;
      dbg('BlockScreen', `setFlowSteps[${tag}]`, {
        prevLen,
        nextLen,
        prev: sids(prev),
        next: sids(next),
      });
      return next;
    });
  }, []);
  const setFlowExperience = useCallback((next: CloudBlock | undefined, tag: string) => {
    setFlowExperienceRaw(prev => {
      dbg('BlockScreen', `setFlowExperience[${tag}]`, {
        from: sid(prev?.id ?? null),
        to: sid(next?.id ?? null),
      });
      return next;
    });
  }, []);

  // Log initial mount (route state at mount time)
  useEffect(() => {
    dbg('BlockScreen', 'mount', {
      block: sid(state?.block?.id ?? null),
      editMode: !!state?.editMode,
      flowExp: sid(state?.flowExperience?.id ?? null),
      flowSteps: sids(state?.flowSteps),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync local state when the route changes (e.g., switching between flow steps).
  useEffect(() => {
    if (state?.block && state.block.id !== block?.id) {
      dbg('BlockScreen', 'route-sync', {
        from: sid(block?.id ?? null),
        to: sid(state.block.id),
        editMode: !!state.editMode,
        flowExp: sid(state.flowExperience?.id ?? null),
        flowSteps: sids(state.flowSteps),
      });
      setBlock(state.block);
      setShowEditor(!!state.editMode);
      if (state.flowExperience !== undefined) setFlowExperience(state.flowExperience, 'route-sync');
      if (state.flowSteps !== undefined) setFlowSteps(state.flowSteps, 'route-sync');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.block?.id]);

  // When the current block belongs to an Experience flow, load the parent
  // experience + all step blocks so we can pass them to the editor's
  // preview row. We also hold the Experience doc locally so the `+` handler
  // can build the next step synchronously without a round-trip.
  useEffect(() => {
    if (!user || !block) {
      dbg('BlockScreen', 'flow-load:skip-no-block');
      setFlowSteps(undefined, 'flow-load-no-block'); setFlowExperience(undefined, 'flow-load-no-block'); return;
    }
    const parentId = (block as Block & { parentExperienceId?: string | null }).parentExperienceId;
    if (!parentId) {
      dbg('BlockScreen', 'flow-load:skip-no-parent', { block: sid(block.id) });
      setFlowSteps(undefined, 'flow-load-no-parent'); setFlowExperience(undefined, 'flow-load-no-parent'); return;
    }
    dbg('BlockScreen', 'flow-load:start', { block: sid(block.id), parent: sid(parentId) });
    let cancelled = false;
    (async () => {
      const experience = await getDraft(user.uid, parentId);
      if (!experience || cancelled) {
        dbg('BlockScreen', 'flow-load:experience-missing', { cancelled });
        return;
      }
      dbg('BlockScreen', 'flow-load:experience-fetched', { experience: sid(experience.id), steps: experience.experienceConfig?.steps.length ?? 0 });
      setFlowExperience(experience, 'flow-load');
      const steps = await loadFlowStepBlocks({ uid: user.uid, experience });
      if (cancelled) return;
      const rawCount = steps.length;
      const filtered = steps.filter((s): s is CloudBlock => s !== null);
      dbg('BlockScreen', 'flow-load:steps-fetched', {
        rawCount,
        filteredCount: filtered.length,
        droppedNulls: rawCount - filtered.length,
        ids: sids(filtered),
      });
      setFlowSteps(filtered, 'flow-load');
    })();
    return () => {
      dbg('BlockScreen', 'flow-load:cancel', { block: sid(block.id) });
      cancelled = true;
    };
  }, [user, block?.id, (block as Block & { parentExperienceId?: string | null })?.parentExperienceId]);

  // When arriving with editMode=true on a member of a flow that isn't step 0,
  // redirect to step 0. Ensures that tapping a wheel from the My Blocks list
  // always lands on the first wheel of its flow (with the editor overlay open).
  const redirectedOnceRef = useRef(false);
  useEffect(() => {
    if (redirectedOnceRef.current) { dbg('BlockScreen', 'redirect:already-done'); return; }
    if (!state?.editMode) return;
    if (!block || !user) return;
    const parentId = (block as Block & { parentExperienceId?: string | null }).parentExperienceId;
    if (!parentId) { dbg('BlockScreen', 'redirect:skip-no-parent', { block: sid(block.id) }); return; }
    dbg('BlockScreen', 'redirect:check', { block: sid(block.id), parent: sid(parentId) });
    let cancelled = false;
    (async () => {
      const experience = await getDraft(user.uid, parentId);
      if (!experience || cancelled) return;
      const steps = await loadFlowStepBlocks({ uid: user.uid, experience });
      const loadedSteps = steps.filter((s): s is CloudBlock => s !== null);
      if (cancelled) return;
      if (loadedSteps.length > 0 && loadedSteps[0].id !== block.id) {
        redirectedOnceRef.current = true;
        dbg('BlockScreen', 'redirect:navigate', { from: sid(block.id), to: sid(loadedSteps[0].id) });
        navigate(`/block/${loadedSteps[0].id}`, {
          replace: true,
          state: {
            block: loadedSteps[0],
            editMode: true,
            flowExperience: experience,
            flowSteps: loadedSteps,
          },
        });
      } else {
        dbg('BlockScreen', 'redirect:already-at-step0', { block: sid(block.id) });
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [block?.id, state?.editMode]);

  const handleBlockUpdated = useCallback((updated: Block) => {
    setBlock(updated);
    // Keep the in-memory flowSteps mirror in sync with the edit. Otherwise
    // the preview tile for this block shows its pre-edit config until the
    // next flow-load fetch from Firestore (causing a visible flash on
    // wheel-switch).
    setFlowStepsRaw(prev => {
      if (!prev) return prev;
      const idx = prev.findIndex(s => s.id === updated.id);
      if (idx < 0) return prev;
      const next = [...prev];
      next[idx] = { ...next[idx], ...updated } as CloudBlock;
      dbg('BlockScreen', 'flowSteps:patch-on-block-update', { id: sid(updated.id), idx });
      return next;
    });
    onBlockUpdated?.(updated);
  }, [onBlockUpdated]);

  if (!block) return <div>Block not found</div>;

  return (
    <>
      <BlockViewLayer
        block={block}
        wheelRef={wheelRef}
        onBack={() => navigate('/')}
        onEdit={async () => {
          // When the block is part of a flow, always open the editor on the
          // first wheel — regardless of which step the user navigated here
          // from. The preview row lets them switch after.
          let steps = flowSteps;
          let exp = flowExperience;
          const parentId = (block as Block & { parentExperienceId?: string | null }).parentExperienceId;
          if (parentId && !steps && user) {
            const experience = await getDraft(user.uid, parentId);
            if (experience) {
              exp = experience;
              const loaded = await loadFlowStepBlocks({ uid: user.uid, experience });
              steps = loaded.filter((s): s is CloudBlock => s !== null);
            }
          }
          if (steps && steps.length > 0 && steps[0].id !== block.id) {
            navigate(`/block/${steps[0].id}`, {
              state: {
                block: steps[0],
                editMode: true,
                flowExperience: exp,
                flowSteps: steps,
              },
            });
            return;
          }
          setShowEditor(true);
        }}
        onBlockUpdated={handleBlockUpdated}
      />

      {/* Non-draggable full-screen overlay sheet containing the editor */}
      <FullScreenSheet visible={showEditor}>
        {/* Intentionally no key here — RouletteScreen stays mounted across
            flow switches to avoid re-animating the internal editor sheet.
            When block.id changes, RouletteScreen's own effects reset
            currentConfig and the editor's useHistory stack. */}
        <RouletteScreen
          block={block}
          editMode
          overlay
          onDismiss={() => setShowEditor(false)}
          onBlockUpdated={handleBlockUpdated}
          flowSteps={flowSteps}
          flowExperience={flowExperience}
          onFlowChange={(exp, steps) => {
            dbg('BlockScreen', 'onFlowChange', { exp: sid(exp?.id ?? null), steps: sids(steps) });
            setFlowExperience(exp, 'onFlowChange');
            setFlowSteps(steps, 'onFlowChange');
          }}
        />
      </FullScreenSheet>
    </>
  );
}

// ── Backdrop/view layer — preview + settings ─────────────────────────────

function BlockViewLayer({
  block, wheelRef, onBack, onEdit, onBlockUpdated,
}: {
  block: Block;
  wheelRef: React.RefObject<SpinningWheelHandle | null>;
  onBack: () => void;
  onEdit: () => void;
  onBlockUpdated: (b: Block) => void;
}) {
  const config = block.wheelConfig;
  const screenWidth = window.innerWidth;
  const wheelSize = Math.min(screenWidth - 40, 420);

  return (
    <div style={{ minHeight: '100dvh', backgroundColor: '#F8F8F9', paddingBottom: 40 }}>
      {/* Top bar */}
      <div style={{ display: 'flex', alignItems: 'center', padding: '12px 8px', backgroundColor: '#F8F8F9' }}>
        <button onClick={onBack} style={{ padding: 8, background: 'none', border: 'none', cursor: 'pointer' }}>
          <ArrowLeft size={26} color={ON_SURFACE} />
        </button>
        <h1 style={{ margin: 0, marginLeft: 4, fontSize: 20, fontWeight: 800, color: ON_SURFACE, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {block.name}
        </h1>
      </div>

      {/* Wheel preview */}
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        padding: '4px 20px 20px',
      }}>
        {config ? (
          <SpinningWheel
            ref={wheelRef}
            items={config.items}
            onFinished={() => {}}
            size={wheelSize}
            textSizeMultiplier={config.textSize}
            headerTextSizeMultiplier={config.headerTextSize}
            imageSize={config.imageSize}
            cornerRadius={config.cornerRadius}
            innerCornerStyle={config.innerCornerStyle}
            centerInset={config.centerInset}
            strokeWidth={config.strokeWidth}
            showBackgroundCircle={config.showBackgroundCircle}
            centerMarkerSize={config.centerMarkerSize}
            spinIntensity={0.5}
            isRandomIntensity
            headerTextColor={ON_SURFACE}
            overlayColor="#000000"
            showWinAnimation
          />
        ) : null}

        <div style={{ width: '100%', maxWidth: 420, marginTop: 18 }}>
          <PushDownButton color={PRIMARY} onTap={() => wheelRef.current?.spin()}>
            <span style={{ color: '#FFF', fontSize: 20, fontWeight: 800, letterSpacing: 2 }}>SPIN</span>
          </PushDownButton>
          <div style={{ height: 10 }} />
          <PushDownButton color={ON_SURFACE} onTap={onEdit}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: '#FFF' }}>
              <Pencil size={18} />
              <span style={{ fontSize: 15, fontWeight: 700 }}>Edit wheel</span>
            </div>
          </PushDownButton>
        </div>
      </div>

      {/* Settings sections */}
      <div style={{ padding: '8px 16px' }}>
        <PublishingSection block={block} onBlockUpdated={onBlockUpdated} />
        <SpinSection />
        <MoreSection block={block} />
      </div>
    </div>
  );
}

// ── Publishing (extracted from PublishSheet + unpublish/sync controls) ───

function PublishingSection({ block, onBlockUpdated: _onBlockUpdated }: { block: Block; onBlockUpdated: (b: Block) => void }) {
  const { profile } = useAuth();
  const publishedWheelId = (block as Block & { publishedWheelId?: string | null }).publishedWheelId;
  const isPublished = !!publishedWheelId;

  const [isChallenge, setIsChallenge] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // TODO: when isPublished, hydrate local state from the remote wheel doc so
  // toggles reflect the live state. For now this section shows controls to
  // (re-)publish or unpublish.

  const onPublish = async () => {
    if (!profile || busy) return;
    if (isChallenge && !prompt.trim()) { setErr('Challenge needs a prompt.'); return; }
    setBusy(true); setErr(null);
    try {
      const wheelId = await publishWheel({
        author: profile,
        draft: block,
        isChallenge,
        challengePrompt: isChallenge ? prompt.trim() : null,
        coverUrl: null,
      });
      if (coverFile) {
        const coverUrl = await uploadImage({ purpose: 'wheel-cover', source: coverFile, wheelId });
        await setDoc(doc(db, 'wheels', wheelId), { coverUrl, updatedAtServer: serverTimestamp() }, { merge: true });
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Publish failed.');
    } finally {
      setBusy(false);
    }
  };

  const onResync = async () => {
    if (!profile || !publishedWheelId || busy) return;
    setBusy(true); setErr(null);
    try {
      await syncPublishedWheel({ uid: profile.uid, wheelId: publishedWheelId });
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Sync failed.');
    } finally {
      setBusy(false);
    }
  };

  const onUnpublish = async () => {
    if (!profile || !publishedWheelId || busy) return;
    if (!confirm('Unpublish this wheel? It will no longer appear on the Feed.')) return;
    setBusy(true); setErr(null);
    try {
      await unpublishWheel({ uid: profile.uid, wheelId: publishedWheelId });
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Unpublish failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Publishing" icon={<Share2 size={16} />}>
      {isPublished ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <InfoRow label="Status" value={<Pill color="#10B981">Published</Pill>} />
          <div style={{ display: 'flex', gap: 8 }}>
            <SecondaryButton onClick={onResync} disabled={busy}>
              Sync latest edits
            </SecondaryButton>
            <SecondaryButton onClick={onUnpublish} disabled={busy} danger>
              Unpublish
            </SecondaryButton>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <ToggleRow
            label="Make it a challenge"
            subtitle="Others can upload photo responses to their spin result."
            icon={<Trophy size={20} />}
            value={isChallenge}
            onChange={setIsChallenge}
          />
          {isChallenge && (
            <div>
              <FieldLabel>Challenge prompt</FieldLabel>
              <InsetTextField value={prompt} onChange={setPrompt} placeholder="Show us your spin result!" />
            </div>
          )}
          <div>
            <FieldLabel>Cover image (optional)</FieldLabel>
            <label style={pickerStyle}>
              <ImageIcon size={18} color={withAlpha(ON_SURFACE, 0.5)} />
              <span style={{ fontSize: 14, fontWeight: 600, color: withAlpha(ON_SURFACE, 0.7) }}>
                {coverFile ? coverFile.name : 'Choose image…'}
              </span>
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={e => { const f = e.target.files?.[0]; if (f) setCoverFile(f); }}
                style={{ display: 'none' }}
              />
            </label>
          </div>
          <PushDownButton color={PRIMARY} onTap={busy ? undefined : onPublish}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#FFF' }}>
              {busy && <Loader2 size={16} className="spin" />}
              <span style={{ fontWeight: 700, fontSize: 15, opacity: busy ? 0.6 : 1 }}>
                {busy ? 'Publishing…' : 'Publish'}
              </span>
            </div>
          </PushDownButton>
        </div>
      )}
      {err && <p style={{ color: '#EF4444', fontSize: 13, margin: '10px 0 0' }}>{err}</p>}
    </Section>
  );
}

// ── Spin settings (extracted from old GearMenu) ──────────────────────────

function SpinSection() {
  // TODO: persist these per-block instead of per-session. Right now they're
  // not wired to anything durable — only local runtime state within RouletteScreen.
  const [randomIntensity, setRandomIntensity] = useState(true);
  const [winEffects, setWinEffects] = useState(true);

  return (
    <Section title="Spin" icon={<Shuffle size={16} />}>
      <ToggleRow
        label="Random intensity"
        icon={<Shuffle size={20} />}
        value={randomIntensity}
        onChange={setRandomIntensity}
      />
      <div style={{ height: 8 }} />
      <ToggleRow
        label="Win effects"
        icon={<Sparkles size={20} />}
        value={winEffects}
        onChange={setWinEffects}
      />
      <p style={{ fontSize: 11, color: withAlpha(ON_SURFACE, 0.45), margin: '8px 4px 0' }}>
        Not yet saved per-wheel — applies only in this session.
      </p>
    </Section>
  );
}

// ── Placeholder "more" settings — not yet wired ──────────────────────────

function MoreSection({ block: _block }: { block: Block }) {
  return (
    <Section title="More" icon={<FileText size={16} />}>
      <ComingSoonRow icon={<FileText size={18} />} label="Description" />
      <ComingSoonRow icon={<Tag size={18} />} label="Tags" />
      <ComingSoonRow icon={<Lock size={18} />} label="Visibility" />
      <ComingSoonRow icon={<Trash2 size={18} />} label="Delete wheel" danger />
    </Section>
  );
}

// ── Full-screen sheet wrapper — non-draggable, slides up ─────────────────

function FullScreenSheet({ visible, children }: { visible: boolean; children: React.ReactNode }) {
  const [mounted, setMounted] = useState(visible);
  const [animIn, setAnimIn] = useState(visible);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      // Kick the enter transition on next frame
      requestAnimationFrame(() => setAnimIn(true));
    } else {
      setAnimIn(false);
      const t = setTimeout(() => setMounted(false), 260);
      return () => clearTimeout(t);
    }
  }, [visible]);

  if (!mounted) return null;

  return (
    <div style={{
      position: 'fixed',
      top: 0, left: 0, right: 0, bottom: 0,
      zIndex: 100,
      transform: animIn ? 'translateY(0)' : 'translateY(100%)',
      transition: 'transform 0.26s cubic-bezier(0.32, 0.72, 0, 1)',
      backgroundColor: '#000',
      overflow: 'hidden',
    }}>
      {children}
    </div>
  );
}

// ── Small UI primitives ──────────────────────────────────────────────────

function Section({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{
      backgroundColor: '#FFF',
      borderRadius: 16,
      border: `1.5px solid ${BORDER}`,
      padding: 14,
      marginBottom: 14,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <div style={{ color: withAlpha(ON_SURFACE, 0.55) }}>{icon}</div>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: withAlpha(ON_SURFACE, 0.55), letterSpacing: 0.4, textTransform: 'uppercase' }}>
          {title}
        </h3>
      </div>
      {children}
    </div>
  );
}

function ToggleRow({ label, subtitle, icon, value, onChange }: {
  label: string; subtitle?: string; icon: React.ReactNode; value: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <div
      onClick={() => onChange(!value)}
      style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '12px 14px', borderRadius: 12,
        backgroundColor: value ? withAlpha(PRIMARY, 0.1) : '#F4F4F5',
        border: `1.5px solid ${value ? PRIMARY : BORDER}`,
        cursor: 'pointer',
      }}
    >
      <div style={{ color: value ? PRIMARY : withAlpha(ON_SURFACE, 0.5) }}>{icon}</div>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 700, fontSize: 14, color: ON_SURFACE }}>{label}</div>
        {subtitle && <div style={{ fontSize: 12, color: withAlpha(ON_SURFACE, 0.55), marginTop: 2 }}>{subtitle}</div>}
      </div>
      {value ? <CheckCircle size={20} color={PRIMARY} /> : <Circle size={20} color={BORDER} />}
    </div>
  );
}

function ComingSoonRow({ icon, label, danger }: { icon: React.ReactNode; label: string; danger?: boolean }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '12px 4px', borderBottom: `1px solid ${BORDER}`,
      color: danger ? '#EF4444' : withAlpha(ON_SURFACE, 0.45),
    }}>
      {icon}
      <span style={{ flex: 1, fontSize: 14, fontWeight: 600 }}>{label}</span>
      <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 8, backgroundColor: withAlpha(ON_SURFACE, 0.06), color: withAlpha(ON_SURFACE, 0.45) }}>
        Coming soon
      </span>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', padding: '6px 4px' }}>
      <span style={{ flex: 1, fontSize: 14, fontWeight: 600, color: withAlpha(ON_SURFACE, 0.65) }}>{label}</span>
      {value}
    </div>
  );
}

function Pill({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span style={{ padding: '3px 10px', borderRadius: 10, backgroundColor: withAlpha(color, 0.14), color, fontSize: 12, fontWeight: 700 }}>
      {children}
    </span>
  );
}

function SecondaryButton({ onClick, disabled, danger, children }: {
  onClick: () => void; disabled?: boolean; danger?: boolean; children: React.ReactNode;
}) {
  const color = danger ? '#EF4444' : ON_SURFACE;
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        flex: 1,
        padding: '10px 14px',
        borderRadius: 12,
        border: `1.5px solid ${BORDER}`,
        backgroundColor: '#FFF',
        color,
        fontWeight: 700,
        fontSize: 13,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label style={{
      display: 'block',
      fontSize: 12, fontWeight: 700,
      color: withAlpha(ON_SURFACE, 0.6),
      margin: '0 0 6px 4px',
    }}>
      {children}
    </label>
  );
}

const pickerStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10,
  padding: '12px 14px',
  borderRadius: 12,
  border: `1.5px dashed ${BORDER}`,
  backgroundColor: '#F8F8F9',
  cursor: 'pointer',
};
