import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import SpinningWheel, { type SpinningWheelHandle } from '../components/SpinningWheel';
import { PushDownButton } from '../components/PushDownButton';
import ResponseUploadSheet from '../components/ResponseUploadSheet';
import CommentsSection from '../components/CommentsSection';
import { ON_SURFACE, BORDER, PRIMARY, BG } from '../utils/constants';
import { withAlpha } from '../utils/colorUtils';
import { useAuth } from '../contexts/AuthContext';
import { fetchWheel } from '../services/feedService';
import {
  isWheelLiked, likeWheel, unlikeWheel,
  isWheelSaved, saveWheel, unsaveWheel,
  isFollowing, followUser, unfollowUser,
} from '../services/socialService';
import { fetchResponses } from '../services/responseService';
import type { PublishedWheel } from '../types/wheel';
import type { ChallengeResponse } from '../types/response';
import {
  ArrowLeft, Heart, Bookmark, MessageCircle, Trophy, UserPlus, UserCheck,
} from 'lucide-react';

export default function WheelDetailScreen() {
  const { wheelId } = useParams<{ wheelId: string }>();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const wheelRef = useRef<SpinningWheelHandle>(null);

  const [wheel, setWheel] = useState<PublishedWheel | null>(null);
  const [liked, setLiked] = useState(false);
  const [saved, setSaved] = useState(false);
  const [following, setFollowing] = useState(false);
  const [responses, setResponses] = useState<ChallengeResponse[]>([]);
  const [lastResult, setLastResult] = useState<{ idx: number; text: string } | null>(null);
  const [showUpload, setShowUpload] = useState(false);
  const [tab, setTab] = useState<'responses' | 'comments'>('responses');

  // Initial load
  useEffect(() => {
    if (!wheelId) return;
    (async () => {
      const w = await fetchWheel(wheelId);
      setWheel(w);
      if (profile && w) {
        const [l, s, f] = await Promise.all([
          isWheelLiked(profile.uid, w.id),
          isWheelSaved(profile.uid, w.id),
          w.authorId !== profile.uid ? isFollowing(profile.uid, w.authorId) : Promise.resolve(false),
        ]);
        setLiked(l); setSaved(s); setFollowing(f);
      }
      if (w) {
        const page = await fetchResponses(w.id);
        setResponses(page.items);
      }
    })();
  }, [wheelId, profile]);

  const toggleLike = async () => {
    if (!profile || !wheel) return;
    const newLiked = !liked;
    setLiked(newLiked);
    setWheel({ ...wheel, likesCount: wheel.likesCount + (newLiked ? 1 : -1) });
    try {
      if (newLiked) await likeWheel(profile.uid, wheel.id);
      else await unlikeWheel(profile.uid, wheel.id);
    } catch {
      setLiked(!newLiked);
      setWheel(w => w && { ...w, likesCount: w.likesCount + (newLiked ? -1 : 1) });
    }
  };

  const toggleSave = async () => {
    if (!profile || !wheel) return;
    const newSaved = !saved;
    setSaved(newSaved);
    setWheel({ ...wheel, savesCount: wheel.savesCount + (newSaved ? 1 : -1) });
    try {
      if (newSaved) await saveWheel(profile.uid, wheel.id);
      else await unsaveWheel(profile.uid, wheel.id);
    } catch {
      setSaved(!newSaved);
      setWheel(w => w && { ...w, savesCount: w.savesCount + (newSaved ? -1 : 1) });
    }
  };

  const toggleFollow = async () => {
    if (!profile || !wheel || wheel.authorId === profile.uid) return;
    const newF = !following;
    setFollowing(newF);
    try {
      if (newF) await followUser(profile.uid, wheel.authorId);
      else await unfollowUser(profile.uid, wheel.authorId);
    } catch {
      setFollowing(!newF);
    }
  };

  const onSpinFinished = useCallback((idx: number) => {
    if (!wheel?.wheelConfig) return;
    const text = wheel.wheelConfig.items[idx]?.text ?? '';
    setLastResult({ idx, text });
  }, [wheel]);

  const onUploaded = async () => {
    setShowUpload(false);
    if (!wheel) return;
    const page = await fetchResponses(wheel.id);
    setResponses(page.items);
    setWheel(w => w && { ...w, responsesCount: w.responsesCount + 1 });
  };

  if (!wheel) return <div style={{ padding: 40, textAlign: 'center' }}>Loading…</div>;

  const canUploadResponse = wheel.isChallenge && !!profile && !!lastResult;

  return (
    <div style={{ minHeight: '100dvh', backgroundColor: '#000' }}>
      {/* Top bar */}
      <div style={{
        display: 'flex', alignItems: 'center', padding: '12px 8px',
        position: 'sticky', top: 0, zIndex: 10,
      }}>
        <button onClick={() => navigate('/')} style={{ padding: 8, background: 'none', border: 'none' }}>
          <ArrowLeft size={28} color="#FFF" />
        </button>
      </div>

      {/* Wheel */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '16px 0' }}>
        <h1 style={{ color: '#FFF', fontSize: 22, fontWeight: 800, margin: '0 0 4px' }}>
          {wheel.name}
        </h1>
        {wheel.isChallenge && wheel.challengePrompt && (
          <p style={{ color: withAlpha('#FFFFFF', 0.75), fontSize: 13, margin: '0 0 16px', textAlign: 'center', padding: '0 24px' }}>
            <Trophy size={14} style={{ verticalAlign: 'middle' }} /> {wheel.challengePrompt}
          </p>
        )}
        <SpinningWheel
          ref={wheelRef}
          items={wheel.wheelConfig?.items ?? []}
          onFinished={onSpinFinished}
          size={Math.min(window.innerWidth - 40, 560)}
          textSizeMultiplier={wheel.wheelConfig?.textSize ?? 1}
          headerTextSizeMultiplier={wheel.wheelConfig?.headerTextSize ?? 1}
          imageSize={wheel.wheelConfig?.imageSize ?? 60}
          cornerRadius={wheel.wheelConfig?.cornerRadius ?? 8}
          innerCornerStyle={wheel.wheelConfig?.innerCornerStyle ?? 'none'}
          centerInset={wheel.wheelConfig?.centerInset ?? 50}
          strokeWidth={wheel.wheelConfig?.strokeWidth ?? 3}
          showBackgroundCircle={wheel.wheelConfig?.showBackgroundCircle ?? true}
          centerMarkerSize={wheel.wheelConfig?.centerMarkerSize ?? 200}
          spinIntensity={0.5}
          isRandomIntensity
          headerTextColor="#FFFFFF"
          overlayColor="#000000"
          showWinAnimation
        />
        <div style={{ width: '100%', padding: '16px 20px 12px' }}>
          <PushDownButton color={PRIMARY} onTap={() => wheelRef.current?.spin()}>
            <span style={{ color: '#FFF', fontSize: 22, fontWeight: 800, letterSpacing: 2 }}>SPIN</span>
          </PushDownButton>
          {canUploadResponse && (
            <div style={{ marginTop: 10 }}>
              <PushDownButton color="#10B981" onTap={() => setShowUpload(true)}>
                <span style={{ color: '#FFF', fontSize: 15, fontWeight: 700 }}>
                  Upload response for "{lastResult.text}"
                </span>
              </PushDownButton>
            </div>
          )}
        </div>
      </div>

      {/* Sheet-style body */}
      <div style={{
        backgroundColor: BG,
        borderTopLeftRadius: 24,
        borderTopRightRadius: 24,
        padding: '20px 16px 40px',
        marginTop: 8,
      }}>
        {/* Author row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <div
            onClick={() => navigate(`/u/${wheel.authorHandle}`)}
            style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}
          >
            <div style={{
              width: 38, height: 38, borderRadius: '50%',
              backgroundColor: '#E4E4E7',
              backgroundImage: wheel.authorPhotoUrl ? `url(${wheel.authorPhotoUrl})` : undefined,
              backgroundSize: 'cover', backgroundPosition: 'center',
            }} />
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: ON_SURFACE }}>{wheel.authorDisplayName}</div>
              <div style={{ fontSize: 12, color: withAlpha(ON_SURFACE, 0.5) }}>@{wheel.authorHandle}</div>
            </div>
          </div>
          <div style={{ flex: 1 }} />
          {profile && profile.uid !== wheel.authorId && (
            <button onClick={toggleFollow} style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '8px 14px',
              borderRadius: 22,
              border: `1.5px solid ${following ? BORDER : PRIMARY}`,
              backgroundColor: following ? '#FFF' : PRIMARY,
              color: following ? ON_SURFACE : '#FFF',
              fontWeight: 700, fontSize: 13, cursor: 'pointer',
            }}>
              {following ? <><UserCheck size={14} /> Following</> : <><UserPlus size={14} /> Follow</>}
            </button>
          )}
        </div>

        {/* Action row */}
        <div style={{ display: 'flex', gap: 24, padding: '0 6px 16px', borderBottom: `1px solid ${BORDER}` }}>
          <StatButton
            active={liked} onTap={toggleLike}
            icon={<Heart size={22} fill={liked ? '#EF4444' : 'none'} color={liked ? '#EF4444' : ON_SURFACE} />}
            count={wheel.likesCount}
          />
          <StatButton
            active={saved} onTap={toggleSave}
            icon={<Bookmark size={22} fill={saved ? PRIMARY : 'none'} color={saved ? PRIMARY : ON_SURFACE} />}
            count={wheel.savesCount}
          />
          <StatButton
            icon={<MessageCircle size={22} color={ON_SURFACE} />}
            count={wheel.commentsCount}
          />
          {wheel.isChallenge && (
            <StatButton
              icon={<Trophy size={22} color={ON_SURFACE} />}
              count={wheel.responsesCount}
              label="responses"
            />
          )}
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 16, padding: '14px 6px' }}>
          {wheel.isChallenge && (
            <TabButton active={tab === 'responses'} label={`Responses (${wheel.responsesCount})`} onTap={() => setTab('responses')} />
          )}
          <TabButton active={tab === 'comments'} label={`Comments (${wheel.commentsCount})`} onTap={() => setTab('comments')} />
        </div>

        {/* Tab body */}
        {wheel.isChallenge && tab === 'responses'
          ? <ResponsesGrid responses={responses} />
          : <CommentsSection target={{ kind: 'wheel', wheelId: wheel.id }} />
        }
      </div>

      {showUpload && lastResult && (
        <ResponseUploadSheet
          wheelId={wheel.id}
          resultSegmentIndex={lastResult.idx}
          resultSegmentText={lastResult.text}
          challengePrompt={wheel.challengePrompt}
          onClose={() => setShowUpload(false)}
          onUploaded={onUploaded}
        />
      )}
    </div>
  );
}

function StatButton({ icon, count, active, onTap, label }: {
  icon: React.ReactNode; count: number; active?: boolean; onTap?: () => void; label?: string;
}) {
  return (
    <button onClick={onTap}
      style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: 4, background: 'none', border: 'none',
        cursor: onTap ? 'pointer' : 'default',
        color: active ? PRIMARY : ON_SURFACE,
      }}>
      {icon}
      <span style={{ fontSize: 14, fontWeight: 700 }}>{count}</span>
      {label && <span style={{ fontSize: 12, color: withAlpha(ON_SURFACE, 0.5) }}>{label}</span>}
    </button>
  );
}

function TabButton({ active, label, onTap }: { active: boolean; label: string; onTap: () => void }) {
  return (
    <button onClick={onTap} style={{
      background: 'none', border: 'none', padding: '6px 0',
      fontSize: 14, fontWeight: 700,
      color: active ? ON_SURFACE : withAlpha(ON_SURFACE, 0.45),
      borderBottom: active ? `2px solid ${ON_SURFACE}` : '2px solid transparent',
      cursor: 'pointer',
    }}>
      {label}
    </button>
  );
}

function ResponsesGrid({ responses }: { responses: ChallengeResponse[] }) {
  if (responses.length === 0) {
    return (
      <p style={{ fontSize: 14, color: withAlpha(ON_SURFACE, 0.5), textAlign: 'center', padding: '24px 0' }}>
        No responses yet. Be the first to spin and upload.
      </p>
    );
  }
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
      gap: 8,
      padding: '4px',
    }}>
      {responses.map(r => (
        <div key={r.id} style={{
          position: 'relative',
          aspectRatio: '1/1',
          borderRadius: 12,
          overflow: 'hidden',
          backgroundColor: '#E4E4E7',
          backgroundImage: `url(${r.imageUrl})`,
          backgroundSize: 'cover', backgroundPosition: 'center',
        }}>
          <div style={{
            position: 'absolute', bottom: 0, left: 0, right: 0,
            padding: '6px 8px',
            background: 'linear-gradient(to top, rgba(0,0,0,0.7), transparent)',
            color: '#FFF',
            fontSize: 11, fontWeight: 700,
          }}>
            @{r.authorHandle} · {r.resultSegmentText}
          </div>
        </div>
      ))}
    </div>
  );
}
