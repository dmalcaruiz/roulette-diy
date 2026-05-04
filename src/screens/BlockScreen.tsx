import { useState, useRef, useCallback, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Block } from '../models/types';
import RouletteScreen from './RouletteScreen';
import WheelThumbnail from '../components/WheelThumbnail';
import { PushDownButton, InsetTextField } from '../components/PushDownButton';
import ConfirmSheet from '../components/ConfirmSheet';
import { ON_SURFACE, BORDER, PRIMARY } from '../utils/constants';
import { withAlpha } from '../utils/colorUtils';
import { useAuth } from '../contexts/AuthContext';
import { publishExperience, unpublishExperience, syncPublishedExperience } from '../services/publishedExperienceService';
import { uploadImage } from '../services/uploadService';
import { getDraft, type CloudBlock } from '../services/blockService';
import { loadFlowStepBlocks } from '../services/flowService';
import { dbg, sid, sids } from '../utils/debugLog';
import { doc, setDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebase';
import {
  X, Trophy, CheckCircle, Circle, ImageIcon, Shuffle, Sparkles,
  Share2, Lock, Trash2, Tag, FileText, Loader2, Compass,
} from 'lucide-react';

interface BlockScreenProps {
  onBlockUpdated?: (block: Block) => void;
  onBlockDelete?: (id: string) => void;
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

export default function BlockScreen({ onBlockUpdated, onBlockDelete }: BlockScreenProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const state = location.state as BlockRouteState | null;
  const { user } = useAuth();

  const [block, setBlock] = useState<Block | null>(state?.block ?? null);
  // Publish is now the overlay on top of the always-visible editor. Default
  // closed — user opens it from RouletteScreen's app bar.
  const [showPublish, setShowPublish] = useState(false);
  const [flowSteps, setFlowStepsRaw] = useState<CloudBlock[] | undefined>(state?.flowSteps);
  const [flowExperience, setFlowExperienceRaw] = useState<CloudBlock | undefined>(state?.flowExperience);

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
    return () => dbg('BlockScreen', 'unmount', { block: sid(state?.block?.id ?? null) });
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
      // Route changes (e.g. switching flow step) shouldn't force the publish
      // overlay open; keep whatever state it was in.
      if (state.flowExperience !== undefined) setFlowExperience(state.flowExperience, 'route-sync');
      if (state.flowSteps !== undefined) setFlowSteps(state.flowSteps, 'route-sync');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.block?.id]);

  // Refs mirror the latest flow state so the flow-load effect can skip
  // re-fetching when we already have the same experience in memory — that
  // guards in-flight optimistic edits (reorders) from being clobbered by a
  // stale Firestore read that races a pending saveDraft.
  const flowExperienceRef = useRef<CloudBlock | undefined>(undefined);
  const flowStepsRef = useRef<CloudBlock[] | undefined>(undefined);
  flowExperienceRef.current = flowExperience;
  flowStepsRef.current = flowSteps;

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
    // Already have this flow loaded? Skip — local state (including pending
    // optimistic reorders) is authoritative. Navigating between steps of the
    // same flow keeps parentId the same, so we'd otherwise re-fetch here and
    // risk overwriting an in-flight reorder with stale Firestore data.
    if (flowExperienceRef.current?.id === parentId && flowStepsRef.current) {
      dbg('BlockScreen', 'flow-load:skip-cached', { parent: sid(parentId) });
      return;
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
    // In-app navigation always passes flowSteps in route state (profile,
    // tile-tap, +-add). Those paths already pick the intended step at the
    // navigation source, so we don't need to override here. Only fire the
    // Firestore-backed redirect for true deep links — URL pastes, browser
    // refreshes, shared links — which arrive without flowSteps state.
    if (state?.flowSteps) { dbg('BlockScreen', 'redirect:skip-in-app-nav'); return; }
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
    // Only replace the current `block` when the update targets it. Flow
    // ops also pass through here (the experience doc + other step blocks),
    // and we mustn't swap the active wheel for, say, the parent Experience
    // — that was the "flash then blank" bug.
    setBlock(prev => (prev && prev.id === updated.id ? updated : prev));
    // Patch flowExperience if the update is the parent Experience doc.
    setFlowExperienceRaw(prev => (prev && prev.id === updated.id
      ? ({ ...prev, ...updated } as CloudBlock)
      : prev));
    // Keep the in-memory flowSteps mirror in sync with the edit so previews
    // don't flash stale state until the next Firestore fetch.
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

  // Update the parent Experience doc. Local flowExperience is patched
  // optimistically; the Firestore write rides the same saveDraft path as
  // wheel edits (via App.handleBlockUpdated). Declared BEFORE the early
  // return so the hook order is stable across renders.
  const handleFlowExperienceUpdated = useCallback((updated: Block) => {
    setFlowExperienceRaw(prev => (prev && prev.id === updated.id ? { ...prev, ...updated } as CloudBlock : prev));
    onBlockUpdated?.(updated);
  }, [onBlockUpdated]);

  if (!block) return <div>Block not found</div>;

  return (
    <>
      {/* Edit screen is the always-visible base. */}
      <RouletteScreen
        block={block}
        editMode
        onRequestPublish={() => setShowPublish(true)}
        onBlockUpdated={handleBlockUpdated}
        onBlockDelete={onBlockDelete}
        flowSteps={flowSteps}
        flowExperience={flowExperience}
        onFlowChange={(exp, steps) => {
          dbg('BlockScreen', 'onFlowChange', { exp: sid(exp?.id ?? null), steps: sids(steps) });
          setFlowExperience(exp, 'onFlowChange');
          setFlowSteps(steps, 'onFlowChange');
        }}
        // Switch the active wheel without going through React Router. This
        // saves a render-pipeline round-trip vs navigate() — the tile
        // highlight + wheel canvas update on the very next render rather
        // than waiting for the route-state useEffect.
        onSwitchActive={b => setBlock(b)}
      />

      {/* Publish / settings overlay — slides up over the editor. */}
      <FullScreenSheet visible={showPublish}>
        <BlockViewLayer
          block={block}
          flowExperience={flowExperience}
          flowSteps={flowSteps}
          onFlowExperienceUpdated={handleFlowExperienceUpdated}
          onBack={() => setShowPublish(false)}
          onBlockUpdated={handleBlockUpdated}
        />
      </FullScreenSheet>
    </>
  );
}

// ── Backdrop/view layer — preview + settings ─────────────────────────────

function BlockViewLayer({
  block, flowExperience, flowSteps, onFlowExperienceUpdated,
  onBack, onBlockUpdated,
}: {
  block: Block;
  flowExperience?: CloudBlock;
  flowSteps?: CloudBlock[];
  onFlowExperienceUpdated?: (b: Block) => void;
  onBack: () => void;
  onBlockUpdated: (b: Block) => void;
}) {
  const config = block.wheelConfig;

  // Local draft for the title — avoids hitting saveDraft on every keystroke.
  // Flushes to onBlockUpdated on blur. Re-syncs if the block prop changes.
  const [nameDraft, setNameDraft] = useState(block.name);
  useEffect(() => { setNameDraft(block.name); }, [block.id, block.name]);
  const commitName = () => {
    const trimmed = nameDraft.trim();
    if (!trimmed || trimmed === block.name) {
      setNameDraft(block.name);
      return;
    }
    onBlockUpdated({
      ...block,
      name: trimmed,
      wheelConfig: block.wheelConfig ? { ...block.wheelConfig, name: trimmed } : block.wheelConfig,
    });
  };

  // Flow metadata drafts (only relevant when this wheel is part of a flow).
  const [flowNameDraft, setFlowNameDraft] = useState(flowExperience?.name ?? '');
  const [flowDescDraft, setFlowDescDraft] = useState(flowExperience?.experienceConfig?.description ?? '');
  useEffect(() => {
    setFlowNameDraft(flowExperience?.name ?? '');
    setFlowDescDraft(flowExperience?.experienceConfig?.description ?? '');
  }, [flowExperience?.id, flowExperience?.name, flowExperience?.experienceConfig?.description]);
  const commitFlowName = () => {
    if (!flowExperience || !onFlowExperienceUpdated) return;
    const trimmed = flowNameDraft.trim();
    if (!trimmed || trimmed === flowExperience.name) {
      setFlowNameDraft(flowExperience.name);
      return;
    }
    onFlowExperienceUpdated({ ...flowExperience, name: trimmed });
  };
  const commitFlowDesc = () => {
    if (!flowExperience || !onFlowExperienceUpdated) return;
    const current = flowExperience.experienceConfig?.description ?? '';
    const next = flowDescDraft.trim();
    if (next === current.trim()) return;
    onFlowExperienceUpdated({
      ...flowExperience,
      experienceConfig: {
        ...(flowExperience.experienceConfig ?? { steps: [] }),
        description: next || null,
      },
    });
  };

  return (
    <div style={{
      height: '100dvh',
      overflowY: 'auto',
      backgroundColor: '#F8F8F9',
      paddingBottom: 40,
    }}>
      {/* Top bar — close lives on the right for parity with other sheets. */}
      <div style={{ display: 'flex', alignItems: 'center', padding: '12px 8px', backgroundColor: '#F8F8F9' }}>
        {/* Left spacer so the centered title stays centered. */}
        <div style={{ width: 42, height: 42 }} />
        <input
          type="text"
          value={flowExperience ? flowNameDraft : nameDraft}
          onChange={e => {
            const v = e.target.value;
            if (flowExperience) {
              setFlowNameDraft(v);
              const trimmed = v.trim();
              if (trimmed && trimmed !== flowExperience.name) {
                // Propagate each keystroke to App.blocks + Firestore so the
                // profile / flow-step labels update immediately.
                onFlowExperienceUpdated?.({ ...flowExperience, name: trimmed });
              }
            } else {
              setNameDraft(v);
              const trimmed = v.trim();
              if (trimmed && trimmed !== block.name) {
                onBlockUpdated({
                  ...block,
                  name: trimmed,
                  wheelConfig: block.wheelConfig ? { ...block.wheelConfig, name: trimmed } : block.wheelConfig,
                });
              }
            }
          }}
          onBlur={flowExperience ? commitFlowName : commitName}
          placeholder={flowExperience ? 'Flow name' : 'Wheel name'}
          style={{
            flex: 1,
            minWidth: 0,
            margin: '0 4px',
            padding: '4px 6px',
            fontSize: 20,
            fontWeight: 800,
            fontFamily: 'inherit',
            textAlign: 'center',
            color: ON_SURFACE,
            background: 'transparent',
            border: 'none',
            outline: 'none',
            cursor: 'text',
          }}
        />
        <button
          onClick={onBack}
          aria-label="Close"
          style={{
            width: 42, height: 42,
            padding: 8,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          <X size={22} color={ON_SURFACE} />
        </button>
      </div>

      {/* Compact preview strip — matches the edit-screen tile style so the
          publish view reads as the same flow, just in a summary form. */}
      <div style={{
        display: 'flex',
        gap: 10,
        overflowX: 'auto',
        padding: '6px 16px 18px',
      }} className="no-scrollbar">
        {(flowSteps && flowSteps.length > 0 ? flowSteps : (config ? [{
          id: block.id,
          wheelConfig: config,
          name: block.name,
        }] : [])).map(step => {
          const items = step.wheelConfig?.items ?? [];
          const label = step.wheelConfig?.name || step.name;
          return (
            <div
              key={step.id}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 4,
                flexShrink: 0,
              }}
            >
              <div style={{
                width: 88,
                height: 88,
                borderRadius: 16,
                backgroundColor: '#FFFFFF',
                border: `2px solid ${BORDER}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}>
                <WheelThumbnail items={items} size={72} />
              </div>
              <div style={{
                width: 88,
                height: 18,
                fontSize: 11,
                fontWeight: 600,
                color: withAlpha(ON_SURFACE, 0.7),
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                textAlign: 'center',
                lineHeight: '18px',
              }}>
                {label}
              </div>
            </div>
          );
        })}
      </div>

      {/* Settings sections */}
      <div style={{ padding: '8px 16px' }}>
        {flowExperience && (
          <Section title="Flow" icon={<Compass size={16} />}>
            <FieldLabel>Description</FieldLabel>
            <textarea
              value={flowDescDraft}
              onChange={e => setFlowDescDraft(e.target.value)}
              onBlur={commitFlowDesc}
              placeholder="Describe this flow (optional)"
              rows={3}
              style={{
                width: '100%',
                padding: '10px 12px',
                borderRadius: 12,
                border: `1.5px solid ${BORDER}`,
                backgroundColor: '#F8F8F9',
                fontSize: 14,
                fontWeight: 500,
                fontFamily: 'inherit',
                color: ON_SURFACE,
                outline: 'none',
                resize: 'vertical',
                boxSizing: 'border-box',
              }}
            />
          </Section>
        )}
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
  const [showUnpublishConfirm, setShowUnpublishConfirm] = useState(false);

  // TODO: when isPublished, hydrate local state from the remote wheel doc so
  // toggles reflect the live state. For now this section shows controls to
  // (re-)publish or unpublish.

  const onPublish = async () => {
    if (!profile || busy) return;
    if (isChallenge && !prompt.trim()) { setErr('Challenge needs a prompt.'); return; }
    setBusy(true); setErr(null);
    try {
      // Every publish goes through the Experience pipeline: standalone
      // roulette/list drafts get auto-wrapped as a one-step Experience. The
      // returned id is a published_experiences/{id} — readable publicly at
      // /e/{id}/play.
      const experienceId = await publishExperience({
        author: profile,
        draft: block,
        isChallenge,
        challengePrompt: isChallenge ? prompt.trim() : null,
        coverUrl: null,
      });
      if (coverFile) {
        const coverUrl = await uploadImage({ purpose: 'wheel-cover', source: coverFile, wheelId: experienceId });
        await setDoc(doc(db, 'published_experiences', experienceId), { coverUrl, updatedAtServer: serverTimestamp() }, { merge: true });
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
      await syncPublishedExperience({ uid: profile.uid, experienceId: publishedWheelId });
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Sync failed.');
    } finally {
      setBusy(false);
    }
  };

  const onUnpublish = () => setShowUnpublishConfirm(true);

  const doUnpublish = async () => {
    if (!profile || !publishedWheelId || busy) return;
    setBusy(true); setErr(null);
    try {
      await unpublishExperience({ uid: profile.uid, experienceId: publishedWheelId });
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Unpublish failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
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
    {showUnpublishConfirm && (
      <ConfirmSheet
        title="Unpublish this Experience?"
        message="It will no longer be playable at its public URL. Your draft stays untouched."
        confirmLabel="Unpublish"
        destructive
        onConfirm={doUnpublish}
        onClose={() => setShowUnpublishConfirm(false)}
      />
    )}
    </>
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
