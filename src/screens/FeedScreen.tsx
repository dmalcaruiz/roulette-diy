import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchFeedPage, fetchChallengesPage, type PageCursor } from '../services/feedService';
import type { WheelCard } from '../types/wheel';
import { ON_SURFACE, BORDER, PRIMARY, BG, SURFACE, SURFACE_ELEVATED } from '../utils/constants';
import { withAlpha } from '../utils/colorUtils';
import { Trophy, Heart, MessageCircle } from 'lucide-react';
import Skeleton from '../components/Skeleton';

type FeedTab = 'all' | 'challenges';

export default function FeedScreen() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<FeedTab>('all');
  const [items, setItems] = useState<WheelCard[]>([]);
  const [cursor, setCursor] = useState<PageCursor>({ done: false });
  const [loading, setLoading] = useState(false);

  const loadMore = useCallback(async (reset: boolean) => {
    if (loading) return;
    setLoading(true);
    try {
      const fn = tab === 'all' ? fetchFeedPage : fetchChallengesPage;
      const page = await fn(reset ? undefined : cursor);
      setItems(prev => reset ? page.items : [...prev, ...page.items]);
      setCursor(page.cursor);
    } finally {
      setLoading(false);
    }
  }, [tab, cursor, loading]);

  useEffect(() => {
    setItems([]);
    setCursor({ done: false });
    loadMore(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflowY: 'auto', backgroundColor: BG }}>
      <div style={{ padding: '24px 20px 8px' }}>
        <h1 style={{ fontSize: 28, fontWeight: 800, color: ON_SURFACE, margin: 0 }}>Feed</h1>
      </div>

      <div style={{ display: 'flex', gap: 8, padding: '0 20px 12px' }}>
        <TabChip active={tab === 'all'} label="All" onTap={() => setTab('all')} />
        <TabChip active={tab === 'challenges'} label="Challenges" onTap={() => setTab('challenges')} icon={<Trophy size={14} />} />
      </div>

      <div style={{ padding: '0 12px 24px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* Skeleton placeholders during the very first fetch — user sees the
            shape of the feed immediately instead of a blank space. */}
        {items.length === 0 && loading && (
          <>
            <WheelCardSkeleton />
            <WheelCardSkeleton />
            <WheelCardSkeleton />
            <WheelCardSkeleton />
          </>
        )}
        {items.map(w => (
          <WheelCardRow key={w.id} wheel={w} onTap={() => navigate(`/wheel/${w.id}`)} />
        ))}
        {items.length === 0 && !loading && (
          <p style={{ fontSize: 14, color: withAlpha(ON_SURFACE, 0.5), textAlign: 'center', padding: '40px 0' }}>
            Nothing here yet.
          </p>
        )}
        {!cursor.done && items.length > 0 && (
          <button
            onClick={() => loadMore(false)}
            disabled={loading}
            style={{
              padding: 12, fontSize: 13, fontWeight: 700,
              color: withAlpha(ON_SURFACE, 0.6),
              background: 'none', border: `1.5px solid ${BORDER}`, borderRadius: 12,
              cursor: loading ? 'default' : 'pointer',
            }}
          >
            {loading ? 'Loading…' : 'Load more'}
          </button>
        )}
      </div>
    </div>
  );
}

function TabChip({ active, label, onTap, icon }: {
  active: boolean; label: string; onTap: () => void; icon?: React.ReactNode;
}) {
  return (
    <button onClick={onTap} style={{
      display: 'flex', alignItems: 'center', gap: 6,
      padding: '8px 14px',
      borderRadius: 22,
      border: `1.5px solid ${active ? PRIMARY : BORDER}`,
      backgroundColor: active ? withAlpha(PRIMARY, 0.12) : SURFACE,
      color: active ? PRIMARY : ON_SURFACE,
      fontSize: 13, fontWeight: 700, cursor: 'pointer',
    }}>
      {icon} {label}
    </button>
  );
}

function WheelCardSkeleton() {
  return (
    <div
      style={{
        display: 'flex',
        gap: 12,
        padding: 12,
        borderRadius: 16,
        border: `1.5px solid ${BORDER}`,
        backgroundColor: SURFACE,
      }}
    >
      <Skeleton width={80} height={80} radius={12} style={{ flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 4 }}>
        <Skeleton width="65%" height={16} radius={6} />
        <Skeleton width="40%" height={12} radius={6} />
        <div style={{ display: 'flex', gap: 14, marginTop: 6 }}>
          <Skeleton width={36} height={12} radius={6} />
          <Skeleton width={36} height={12} radius={6} />
        </div>
      </div>
    </div>
  );
}

function WheelCardRow({ wheel, onTap }: { wheel: WheelCard; onTap: () => void }) {
  return (
    <div
      onClick={onTap}
      style={{
        display: 'flex',
        gap: 12,
        padding: 12,
        borderRadius: 16,
        border: `1.5px solid ${BORDER}`,
        backgroundColor: SURFACE,
        cursor: 'pointer',
      }}
    >
      <div style={{
        width: 80, height: 80, borderRadius: 12,
        backgroundColor: SURFACE_ELEVATED, flexShrink: 0,
        backgroundImage: wheel.coverUrl ? `url(${wheel.coverUrl})` : undefined,
        backgroundSize: 'cover', backgroundPosition: 'center',
      }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
          {wheel.isChallenge && <Trophy size={14} color={PRIMARY} />}
          <span style={{ fontSize: 16, fontWeight: 700, color: ON_SURFACE, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {wheel.name}
          </span>
        </div>
        <div style={{ fontSize: 12, color: withAlpha(ON_SURFACE, 0.55) }}>
          @{wheel.authorHandle}
        </div>
        <div style={{ display: 'flex', gap: 14, marginTop: 8, fontSize: 12, fontWeight: 600, color: withAlpha(ON_SURFACE, 0.6) }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <Heart size={13} /> {wheel.likesCount}
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <MessageCircle size={13} /> {wheel.commentsCount}
          </span>
          {wheel.isChallenge && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <Trophy size={13} /> {wheel.responsesCount}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
