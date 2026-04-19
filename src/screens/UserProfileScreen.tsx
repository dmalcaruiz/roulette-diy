import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getProfileByHandle } from '../services/profileService';
import { fetchWheelsByAuthor } from '../services/feedService';
import { isFollowing, followUser, unfollowUser } from '../services/socialService';
import type { UserProfile } from '../types/profile';
import type { WheelCard } from '../types/wheel';
import { ON_SURFACE, BORDER, PRIMARY } from '../utils/constants';
import { withAlpha } from '../utils/colorUtils';
import { useAuth } from '../contexts/AuthContext';
import { ArrowLeft, UserPlus, UserCheck, Heart, Trophy, MessageCircle } from 'lucide-react';

export default function UserProfileScreen() {
  const { handle } = useParams<{ handle: string }>();
  const navigate = useNavigate();
  const { profile: me } = useAuth();

  const [target, setTarget] = useState<UserProfile | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [wheels, setWheels] = useState<WheelCard[]>([]);
  const [following, setFollowing] = useState(false);

  useEffect(() => {
    if (!handle) return;
    (async () => {
      const p = await getProfileByHandle(handle);
      if (!p) { setNotFound(true); return; }
      setTarget(p);
      const [ws, f] = await Promise.all([
        fetchWheelsByAuthor(p.uid),
        me && me.uid !== p.uid ? isFollowing(me.uid, p.uid) : Promise.resolve(false),
      ]);
      setWheels(ws);
      setFollowing(f);
    })();
  }, [handle, me]);

  const toggleFollow = async () => {
    if (!me || !target || me.uid === target.uid) return;
    const next = !following;
    setFollowing(next);
    setTarget({ ...target, followersCount: target.followersCount + (next ? 1 : -1) });
    try {
      if (next) await followUser(me.uid, target.uid);
      else await unfollowUser(me.uid, target.uid);
    } catch {
      setFollowing(!next);
    }
  };

  if (notFound) return <div style={{ padding: 40, textAlign: 'center' }}>@{handle} not found.</div>;
  if (!target) return <div style={{ padding: 40, textAlign: 'center' }}>Loading…</div>;

  const isSelf = me?.uid === target.uid;

  return (
    <div style={{ minHeight: '100dvh', backgroundColor: '#FFF' }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '12px 8px' }}>
        <button onClick={() => navigate('/')} style={{ padding: 8, background: 'none', border: 'none' }}>
          <ArrowLeft size={28} color={ON_SURFACE} />
        </button>
      </div>

      <div style={{ padding: '8px 20px 16px', textAlign: 'center' }}>
        <div style={{
          width: 96, height: 96, borderRadius: '50%',
          backgroundColor: '#E4E4E7',
          backgroundImage: target.photoUrl ? `url(${target.photoUrl})` : undefined,
          backgroundSize: 'cover', backgroundPosition: 'center',
          margin: '0 auto 10px',
        }} />
        <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0, color: ON_SURFACE }}>{target.displayName}</h1>
        <p style={{ fontSize: 14, color: withAlpha(ON_SURFACE, 0.55), margin: '2px 0 10px' }}>@{target.handle}</p>
        {target.bio && <p style={{ fontSize: 14, color: ON_SURFACE, margin: '0 0 14px', lineHeight: 1.4 }}>{target.bio}</p>}

        <div style={{ display: 'flex', justifyContent: 'center', gap: 22, margin: '14px 0 14px' }}>
          <Stat count={target.wheelsCount} label="wheels" />
          <Stat count={target.followersCount} label="followers" />
          <Stat count={target.followingCount} label="following" />
        </div>

        {!isSelf && me && (
          <button onClick={toggleFollow} style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '10px 20px',
            borderRadius: 24,
            border: `1.5px solid ${following ? BORDER : PRIMARY}`,
            backgroundColor: following ? '#FFF' : PRIMARY,
            color: following ? ON_SURFACE : '#FFF',
            fontWeight: 700, fontSize: 14, cursor: 'pointer',
          }}>
            {following ? <><UserCheck size={15} /> Following</> : <><UserPlus size={15} /> Follow</>}
          </button>
        )}
      </div>

      <div style={{ padding: '0 12px 32px', borderTop: `1px solid ${BORDER}` }}>
        <h3 style={{ fontSize: 13, fontWeight: 700, color: withAlpha(ON_SURFACE, 0.55), margin: '20px 8px 12px' }}>
          WHEELS
        </h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {wheels.map(w => (
            <div key={w.id}
              onClick={() => navigate(`/wheel/${w.id}`)}
              style={{
                display: 'flex', gap: 12, padding: 10,
                borderRadius: 14, border: `1.5px solid ${BORDER}`, cursor: 'pointer',
              }}>
              <div style={{
                width: 56, height: 56, borderRadius: 10,
                backgroundColor: '#E4E4E7',
                backgroundImage: w.coverUrl ? `url(${w.coverUrl})` : undefined,
                backgroundSize: 'cover', backgroundPosition: 'center',
              }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {w.isChallenge && <Trophy size={13} color={PRIMARY} />}
                  <span style={{ fontSize: 15, fontWeight: 700 }}>{w.name}</span>
                </div>
                <div style={{ display: 'flex', gap: 12, marginTop: 4, fontSize: 12, color: withAlpha(ON_SURFACE, 0.55) }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}><Heart size={12} /> {w.likesCount}</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}><MessageCircle size={12} /> {w.commentsCount}</span>
                  {w.isChallenge && <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}><Trophy size={12} /> {w.responsesCount}</span>}
                </div>
              </div>
            </div>
          ))}
          {wheels.length === 0 && (
            <p style={{ fontSize: 14, color: withAlpha(ON_SURFACE, 0.5), textAlign: 'center', padding: '24px 0' }}>
              No wheels published yet.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ count, label }: { count: number; label: string }) {
  return (
    <div>
      <div style={{ fontSize: 18, fontWeight: 800, color: ON_SURFACE }}>{count.toLocaleString()}</div>
      <div style={{ fontSize: 12, color: withAlpha(ON_SURFACE, 0.5) }}>{label}</div>
    </div>
  );
}
