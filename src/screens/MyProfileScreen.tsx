import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { ON_SURFACE, BORDER, PRIMARY } from '../utils/constants';
import { withAlpha } from '../utils/colorUtils';
import { LogOut, ExternalLink, Activity, UserCircle2 } from 'lucide-react';
import BlocksList from '../components/BlocksList';
import SignInSheet from '../components/SignInSheet';
import ConfirmSheet from '../components/ConfirmSheet';
import Skeleton from '../components/Skeleton';
import { PushDownButton } from '../components/PushDownButton';
import type { CloudBlock } from '../services/blockService';

interface MyProfileScreenProps {
  blocks: CloudBlock[];
  blocksLoaded: boolean;
  onBlockTap: (block: CloudBlock) => void;
  onBlockEdit: (block: CloudBlock) => void;
  onBlockDuplicate: (block: CloudBlock) => void;
  onBlockDelete: (id: string) => void;
  onBlockReorder?: (orderedIds: string[]) => void;
}

export default function MyProfileScreen({
  blocks, blocksLoaded, onBlockTap, onBlockEdit, onBlockDuplicate, onBlockDelete, onBlockReorder,
}: MyProfileScreenProps) {
  const navigate = useNavigate();
  const { user, profile, isAnonymous, signOut } = useAuth();
  const [showSignIn, setShowSignIn] = useState(false);
  const [showSignOutConfirm, setShowSignOutConfirm] = useState(false);

  // First paint can land before anonymous sign-in resolves — show a skeleton
  // shell instead of a blank screen or a centered spinner.
  if (!user) return <ProfileSkeleton />;

  // Anonymous users: render a profile-shaped surface with a sign-in CTA at
  // the top, followed by their local Experiences. Same actions as a real
  // profile, minus the public-profile / handle bits.
  if (isAnonymous || !profile) {
    return (
      <>
        <AnonymousProfile
          blocks={blocks}
          blocksLoaded={blocksLoaded}
          onSignIn={() => setShowSignIn(true)}
          onBlockEdit={onBlockEdit}
          onBlockTap={onBlockTap}
          onBlockDuplicate={onBlockDuplicate}
          onBlockDelete={onBlockDelete}
          onBlockReorder={onBlockReorder}
        />
        {showSignIn && (
          <SignInSheet reason="save" onClose={() => setShowSignIn(false)} />
        )}
      </>
    );
  }

  const onSignOut = () => setShowSignOutConfirm(true);

  return (
    <>
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
        {!blocksLoaded ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '0 8px 24px' }}>
            <BlockRowSkeleton />
            <BlockRowSkeleton />
            <BlockRowSkeleton />
          </div>
        ) : (
        <BlocksList
          // Profile shows everything as flows. Child wheels of an Experience
          // are hidden from the row list — they're accessible by opening their
          // parent flow — but still passed via allBlocks so flow cards can
          // resolve their step blockIds into wheel thumbnails.
          blocks={blocks.filter(b => !b.parentExperienceId)}
          allBlocks={blocks}
          asFlows
          // In My Blocks, card tap and the explicit edit chevron do the same
          // thing: open the block for editing (publish screen + editor overlay).
          // Home's view-only tap is handled by a separate callback in App.tsx.
          onBlockTap={onBlockEdit}
          onBlockEdit={onBlockEdit}
          onBlockDuplicate={onBlockDuplicate}
          onBlockDelete={onBlockDelete}
          onReorder={onBlockReorder}
        />
        )}
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
    {showSignOutConfirm && (
      <ConfirmSheet
        title="Sign out?"
        message="You can sign back in any time. Your published Experiences stay live."
        confirmLabel="Sign out"
        destructive
        onConfirm={() => { signOut(); }}
        onClose={() => setShowSignOutConfirm(false)}
      />
    )}
    </>
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

// Shown while auth is still resolving — same overall layout as the real
// profile so the user sees the structure of the screen, only the content is
// shimmer.
function ProfileSkeleton() {
  return (
    <div style={{ height: '100%', overflowY: 'auto', backgroundColor: '#FFF' }}>
      <div style={{ padding: '24px 20px 8px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <Skeleton width={96} height={96} radius="50%" style={{ margin: '0 auto 12px' }} />
        <Skeleton width={140} height={20} radius={6} style={{ margin: '4px 0 8px' }} />
        <Skeleton width={90} height={14} radius={6} style={{ margin: '0 0 18px' }} />
        <Skeleton width={180} height={36} radius={22} />
      </div>

      <div style={{ padding: '0 12px', marginTop: 24, borderTop: `1px solid ${BORDER}` }}>
        <div style={{ padding: '20px 8px 12px' }}>
          <Skeleton width={130} height={12} radius={4} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '0 8px 24px' }}>
          <BlockRowSkeleton />
          <BlockRowSkeleton />
          <BlockRowSkeleton />
        </div>
      </div>
    </div>
  );
}

function BlockRowSkeleton() {
  return (
    <div
      style={{
        display: 'flex',
        gap: 12,
        padding: 12,
        borderRadius: 16,
        border: `1.5px solid ${BORDER}`,
        backgroundColor: '#FFF',
      }}
    >
      <Skeleton width={56} height={56} radius={12} style={{ flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 6 }}>
        <Skeleton width="60%" height={14} radius={6} />
        <Skeleton width="35%" height={11} radius={6} />
      </div>
    </div>
  );
}

interface AnonymousProfileProps {
  blocks: CloudBlock[];
  blocksLoaded: boolean;
  onSignIn: () => void;
  onBlockTap: (block: CloudBlock) => void;
  onBlockEdit: (block: CloudBlock) => void;
  onBlockDuplicate: (block: CloudBlock) => void;
  onBlockDelete: (id: string) => void;
  onBlockReorder?: (orderedIds: string[]) => void;
}

function AnonymousProfile({
  blocks, blocksLoaded, onSignIn, onBlockTap, onBlockEdit, onBlockDuplicate, onBlockDelete, onBlockReorder,
}: AnonymousProfileProps) {
  return (
    <div style={{ height: '100%', overflowY: 'auto', backgroundColor: '#FFF' }}>
      <div style={{ padding: '24px 20px 8px', textAlign: 'center' }}>
        <div style={{
          width: 96, height: 96, borderRadius: '50%',
          backgroundColor: withAlpha(PRIMARY, 0.1),
          margin: '0 auto 12px',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <UserCircle2 size={56} color={PRIMARY} />
        </div>
        <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0, color: ON_SURFACE }}>
          Guest
        </h1>
        <p style={{ fontSize: 14, color: withAlpha(ON_SURFACE, 0.55), margin: '4px 24px 18px', lineHeight: 1.4 }}>
          Your Experiences are saved on this device. Sign in to sync them across devices and publish.
        </p>

        <div style={{ display: 'inline-block' }}>
          <PushDownButton color={PRIMARY} onTap={onSignIn}>
            <span style={{ color: '#FFF', fontWeight: 700, fontSize: 15, padding: '0 22px' }}>
              Sign in to save forever
            </span>
          </PushDownButton>
        </div>
      </div>

      <div style={{ padding: '0 12px', marginTop: 24, borderTop: `1px solid ${BORDER}` }}>
        <h3 style={{ fontSize: 13, fontWeight: 700, color: withAlpha(ON_SURFACE, 0.55), margin: '20px 8px 12px' }}>
          YOUR EXPERIENCES
        </h3>
        {!blocksLoaded ? (
          // Cold-load placeholder: shimmer tiles in the same row shape so the
          // list reads as "loading" rather than "empty."
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '0 8px 24px' }}>
            <BlockRowSkeleton />
            <BlockRowSkeleton />
            <BlockRowSkeleton />
          </div>
        ) : blocks.length === 0 ? (
          <p style={{ fontSize: 14, color: withAlpha(ON_SURFACE, 0.5), padding: '8px 8px 24px' }}>
            Nothing here yet. Tap Create to build your first Experience.
          </p>
        ) : (
          <BlocksList
            blocks={blocks.filter(b => !b.parentExperienceId)}
            allBlocks={blocks}
            asFlows
            onBlockTap={onBlockTap}
            onBlockEdit={onBlockEdit}
            onBlockDuplicate={onBlockDuplicate}
            onBlockDelete={onBlockDelete}
            onReorder={onBlockReorder}
          />
        )}
      </div>
    </div>
  );
}
