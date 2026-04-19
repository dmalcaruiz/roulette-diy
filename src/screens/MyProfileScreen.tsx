import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { ON_SURFACE, BORDER, PRIMARY } from '../utils/constants';
import { withAlpha } from '../utils/colorUtils';
import { LogOut, ExternalLink, Activity } from 'lucide-react';
import BlocksList from '../components/BlocksList';
import type { CloudBlock } from '../services/blockService';

interface MyProfileScreenProps {
  blocks: CloudBlock[];
  onBlockTap: (block: CloudBlock) => void;
  onBlockEdit: (block: CloudBlock) => void;
  onBlockDuplicate: (block: CloudBlock) => void;
  onBlockDelete: (id: string) => void;
}

export default function MyProfileScreen({
  blocks, onBlockTap, onBlockEdit, onBlockDuplicate, onBlockDelete,
}: MyProfileScreenProps) {
  const navigate = useNavigate();
  const { profile, signOut } = useAuth();

  if (!profile) return null;

  const onSignOut = async () => {
    if (!confirm('Sign out?')) return;
    await signOut();
  };

  return (
    <div style={{ height: '100%', overflowY: 'auto', backgroundColor: '#FFF' }}>
      {/* Header */}
      <div style={{ padding: '24px 20px 12px', textAlign: 'center' }}>
        <div style={{
          width: 96, height: 96, borderRadius: '50%',
          backgroundColor: '#E4E4E7',
          backgroundImage: profile.photoUrl ? `url(${profile.photoUrl})` : undefined,
          backgroundSize: 'cover', backgroundPosition: 'center',
          margin: '0 auto 10px',
        }} />
        <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0, color: ON_SURFACE }}>
          {profile.displayName}
        </h1>
        <p style={{ fontSize: 14, color: withAlpha(ON_SURFACE, 0.55), margin: '2px 0 10px' }}>
          @{profile.handle}
        </p>
        {profile.bio && (
          <p style={{ fontSize: 14, color: ON_SURFACE, margin: '0 20px 14px', lineHeight: 1.4 }}>
            {profile.bio}
          </p>
        )}

        <div style={{ display: 'flex', justifyContent: 'center', gap: 22, margin: '14px 0' }}>
          <Stat count={profile.wheelsCount} label="wheels" />
          <Stat count={profile.followersCount} label="followers" />
          <Stat count={profile.followingCount} label="following" />
        </div>

        <button
          onClick={() => navigate(`/u/${profile.handle}`)}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '8px 16px',
            borderRadius: 22,
            border: `1.5px solid ${BORDER}`,
            backgroundColor: '#FFF',
            color: ON_SURFACE,
            fontWeight: 700, fontSize: 13, cursor: 'pointer',
          }}
        >
          <ExternalLink size={14} /> View public profile
        </button>
      </div>

      {/* Your wheels — unified list (drafts + published with status + stats) */}
      <div style={{ padding: '0 12px', borderTop: `1px solid ${BORDER}` }}>
        <h3 style={{ fontSize: 13, fontWeight: 700, color: withAlpha(ON_SURFACE, 0.55), margin: '20px 8px 12px' }}>
          YOUR WHEELS
        </h3>
        <BlocksList
          blocks={blocks}
          // In My Blocks, card tap and the explicit edit chevron do the same
          // thing: open the block for editing (publish screen + editor overlay).
          // Home's view-only tap is handled by a separate callback in App.tsx.
          onBlockTap={onBlockEdit}
          onBlockEdit={onBlockEdit}
          onBlockDuplicate={onBlockDuplicate}
          onBlockDelete={onBlockDelete}
        />
      </div>

      {/* Settings */}
      <div style={{ padding: '8px 12px 32px', marginTop: 24, borderTop: `1px solid ${BORDER}` }}>
        <h3 style={{ fontSize: 13, fontWeight: 700, color: withAlpha(ON_SURFACE, 0.55), margin: '20px 8px 12px' }}>
          SETTINGS
        </h3>
        <button
          onClick={() => navigate('/diagnostics')}
          style={{
            display: 'flex', alignItems: 'center', gap: 12,
            width: '100%',
            padding: '14px 16px',
            borderRadius: 14,
            border: `1.5px solid ${BORDER}`,
            backgroundColor: '#FFF',
            color: ON_SURFACE,
            fontWeight: 700, fontSize: 15,
            cursor: 'pointer',
            textAlign: 'left',
            marginBottom: 10,
          }}
        >
          <Activity size={20} />
          Diagnostics
        </button>
        <button
          onClick={onSignOut}
          style={{
            display: 'flex', alignItems: 'center', gap: 12,
            width: '100%',
            padding: '14px 16px',
            borderRadius: 14,
            border: `1.5px solid ${BORDER}`,
            backgroundColor: '#FFF',
            color: '#EF4444',
            fontWeight: 700, fontSize: 15,
            cursor: 'pointer',
            textAlign: 'left',
          }}
        >
          <LogOut size={20} />
          Sign out
        </button>
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
