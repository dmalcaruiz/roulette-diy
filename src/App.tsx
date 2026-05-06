import { useState, useEffect, useCallback } from 'react';
import { Routes, Route, useNavigate, useLocation, Navigate } from 'react-router-dom';
import { Block, BlockType, newRouletteBlock, newListRandomizerBlock } from './models/types';
import { loadDrafts, saveDraft, deleteDraft, saveDraftOrder, migrateLocalBlocksIfNeeded, type CloudBlock } from './services/blockService';
import { dbg, sid, sids } from './utils/debugLog';
import { useAuth } from './contexts/AuthContext';
import LoginScreen from './screens/LoginScreen';
import ProfileSetupScreen from './screens/ProfileSetupScreen';
import CreateSheet from './screens/CreateSheet';
import BlockScreen from './screens/BlockScreen';
import ListRandomizerScreen from './screens/ListRandomizerScreen';
import FeedScreen from './screens/FeedScreen';
import WheelDetailScreen from './screens/WheelDetailScreen';
import UserProfileScreen from './screens/UserProfileScreen';
import MyProfileScreen from './screens/MyProfileScreen';
import DiagnosticsScreen from './screens/DiagnosticsScreen';
import ExperiencePlayScreen from './screens/ExperiencePlayScreen';
import { withAlpha } from './utils/colorUtils';
import { ON_SURFACE, PRIMARY, BORDER, SURFACE } from './utils/constants';
import { PlusCircle, Compass, User } from 'lucide-react';

export default function App() {
  const { user, profile, authLoading, profileLoading, isAnonymous, anonymousAuthBlocked } = useAuth();
  const [blocks, setBlocks] = useState<CloudBlock[]>([]);
  // True until the first drafts fetch returns (success OR failure). Lets the
  // Profile tab show shimmer tiles instead of the empty state during cold load.
  const [blocksLoaded, setBlocksLoaded] = useState(false);
  const [showCreateSheet, setShowCreateSheet] = useState(false);
  const navigate = useNavigate();

  const reload = useCallback(async () => {
    if (!user) return;
    try {
      const drafts = await loadDrafts(user.uid);
      setBlocks(drafts);
    } catch (e) {
      console.error('Failed to load drafts:', e);
    } finally {
      setBlocksLoaded(true);
    }
  }, [user]);

  // Run migration + initial load once we have a user (anonymous or permanent).
  // Anonymous users still get to load/create drafts under their anon uid; once
  // they link to Google, the same uid carries the data forward.
  useEffect(() => {
    if (!user) return;
    (async () => {
      try {
        const { migrated } = await migrateLocalBlocksIfNeeded(user.uid);
        if (migrated > 0) console.log(`Migrated ${migrated} blocks from localStorage.`);
        await reload();
      } catch (e) {
        console.error('Migration/reload failed:', e);
        setBlocksLoaded(true);
      }
    })();
  }, [user, reload]);

  const handleBlockUpdated = useCallback(async (updated: Block) => {
    if (!user) return;
    // Optimistic: reflect the edit in the list immediately so nav back feels instant.
    setBlocks(prev => {
      const idx = prev.findIndex(b => b.id === updated.id);
      if (idx < 0) return [...prev, updated];
      const next = [...prev];
      next[idx] = { ...prev[idx], ...updated };
      return next;
    });
    try {
      await saveDraft(user.uid, updated);
    } catch (e) {
      console.error('saveDraft failed:', e);
      reload(); // revert on failure
    }
  }, [user, reload]);

  const handleBlockDuplicate = useCallback(async (block: Block) => {
    if (!user) return;
    const duplicate: Block = {
      ...block,
      id: Date.now().toString(),
      name: `${block.name} (Copy)`,
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    };
    await saveDraft(user.uid, duplicate);
    reload();
  }, [user, reload]);

  // Profile-tab drag-reorder commit. `orderedIds` is the new order of the
  // *displayed* (top-level, non-child) blocks. We re-sort blocks state so
  // top-level blocks follow that order while keeping child blocks adjacent
  // to their parent (preserving the children's relative order). The
  // Firestore write writes a fresh `order` index for every block in the
  // new sequence, so loadDrafts(orderBy('order')) returns this exact order
  // on the next cold load.
  const handleBlockReorder = useCallback((orderedIds: string[]) => {
    if (!user) return;
    setBlocks(prev => {
      const byId = new Map(prev.map(b => [b.id, b]));
      const childrenByParent = new Map<string, CloudBlock[]>();
      for (const b of prev) {
        if (b.parentExperienceId) {
          const arr = childrenByParent.get(b.parentExperienceId) ?? [];
          arr.push(b);
          childrenByParent.set(b.parentExperienceId, arr);
        }
      }
      const next: CloudBlock[] = [];
      for (const id of orderedIds) {
        const b = byId.get(id);
        if (!b) continue;
        next.push(b);
        const kids = childrenByParent.get(b.id);
        if (kids) next.push(...kids);
      }
      // Persist in the background; on failure the next reload reconciles.
      saveDraftOrder(user.uid, next.map(b => b.id)).catch(e => {
        console.error('saveDraftOrder failed:', e);
      });
      return next;
    });
  }, [user]);

  const handleBlockDelete = useCallback((id: string) => {
    if (!user) return;
    // Optimistic: drop the block from local state immediately so any
    // visible list (Profile, recent, flow preview rows) updates this frame.
    // The Firestore delete fires in the background; on failure the next
    // natural reload reconciles.
    setBlocks(prev => prev.filter(b => b.id !== id));
    deleteDraft(user.uid, id).catch(e => console.error('deleteDraft failed:', e));
  }, [user]);

  // Helper: given an Experience and its resolved step blocks, jump to the
  // first step's wheel screen with full flow context attached. BlockScreen
  // renders the wheel + the steps preview row at the bottom — that preview
  // row IS the Experience editor, replacing the old ExperienceBuilderScreen.
  const openFlowAtStep0 = useCallback((experience: CloudBlock, stepBlocks: CloudBlock[], editMode: boolean) => {
    navigate(`/block/${stepBlocks[0].id}`, {
      state: {
        block: stepBlocks[0],
        editMode,
        flowExperience: experience,
        flowSteps: stepBlocks,
      },
    });
  }, [navigate]);

  // Open an Experience by jumping to its first wheel-step. If the Experience
  // has no steps yet, bootstrap a fresh roulette as step 0 so the user lands
  // in the wheel editor immediately — the steps preview row in BlockScreen is
  // the only Experience surface now.
  const openExperienceFlow = useCallback(async (experience: CloudBlock, editMode: boolean) => {
    if (!user) return;
    const steps = experience.experienceConfig?.steps ?? [];
    const resolved = steps
      .map(s => blocks.find(b => b.id === s.blockId))
      .filter((b): b is CloudBlock => !!b);

    if (resolved.length > 0) {
      openFlowAtStep0(experience, resolved, editMode);
      return;
    }

    // Empty Experience — bootstrap a starter wheel + link it back as step 0.
    const starterWheel: CloudBlock = {
      ...newRouletteBlock(),
      parentExperienceId: experience.id,
    };
    const updatedExperience: CloudBlock = {
      ...experience,
      experienceConfig: {
        ...(experience.experienceConfig ?? { steps: [] }),
        steps: [{ blockId: starterWheel.id }],
      },
    };
    await Promise.all([
      saveDraft(user.uid, starterWheel),
      saveDraft(user.uid, updatedExperience),
    ]);
    await reload();
    openFlowAtStep0(updatedExperience, [starterWheel], editMode);
  }, [user, blocks, reload, openFlowAtStep0]);

  const navigateToBlock = useCallback((block: CloudBlock, editMode = false) => {
    dbg('App.navigateToBlock', 'go', { block: sid(block.id), type: block.type, editMode });
    // Experience tiles unify under the wheel screen — never route to the old
    // ExperienceBuilderScreen anymore.
    if (block.type === 'experience') {
      void openExperienceFlow(block, editMode);
      return;
    }
    navigate(`/block/${block.id}`, { state: { block, editMode } });
  }, [navigate, openExperienceFlow]);

  // Open a block for editing. If it's part of a flow, resolve the parent
  // Experience + all step blocks locally (we already have them in `blocks`)
  // and pass them through navigation state — BlockScreen has the full flow
  // on first render, no Firestore fetch delay before the preview row fills.
  const openForEditing = useCallback((block: CloudBlock) => {
    const parentId = block.parentExperienceId;
    dbg('App.openForEditing', 'enter', { block: sid(block.id), parent: sid(parentId ?? null), type: block.type });

    // Child wheel tapped — resolve its parent flow and open step 0.
    if (parentId) {
      const experience = blocks.find(b => b.id === parentId);
      const steps = experience?.experienceConfig?.steps;
      if (experience && steps && steps.length > 0) {
        const stepBlocks = steps
          .map(s => blocks.find(b => b.id === s.blockId))
          .filter((b): b is CloudBlock => !!b);
        if (stepBlocks.length > 0) {
          dbg('App.openForEditing', 'resolved-flow-via-child', {
            exp: sid(experience.id), step0: sid(stepBlocks[0].id), steps: sids(stepBlocks),
          });
          openFlowAtStep0(experience, stepBlocks, true);
          return;
        }
      }
      dbg('App.openForEditing', 'flow-unresolved-fallback', { block: sid(block.id) });
    }

    // Experience itself tapped — always resolves to step 0's wheel via
    // openExperienceFlow (which bootstraps a starter wheel if empty).
    if (block.type === 'experience') {
      void openExperienceFlow(block, true);
      return;
    }

    dbg('App.openForEditing', 'standalone-navigate', { block: sid(block.id) });
    navigateToBlock(block, true);
  }, [blocks, openFlowAtStep0, openExperienceFlow, navigateToBlock]);

  const handleCreateType = useCallback(async (type: BlockType) => {
    // If anonymous sign-in is still resolving (background HTTP from
    // AuthContext), wait briefly for it to land before saving. The user
    // sees the create sheet close instantly; the actual draft creation
    // happens once the uid is available.
    let activeUser = user;
    if (!activeUser) {
      const { auth } = await import('./firebase');
      const { onAuthStateChanged } = await import('firebase/auth');
      activeUser = await new Promise<NonNullable<typeof user>>(resolve => {
        const unsub = onAuthStateChanged(auth, (u) => { if (u) { unsub(); resolve(u); } });
      });
    }
    setShowCreateSheet(false);

    let newBlock: Block;
    switch (type) {
      case 'roulette':
      case 'experience':
        newBlock = newRouletteBlock();
        break;
      case 'listRandomizer':
        newBlock = newListRandomizerBlock();
        break;
      default:
        newBlock = newRouletteBlock(); // unreachable, satisfies TS
    }
    // Optimistic: add the new block to local state and navigate immediately.
    // The Firestore write happens in the background — no two-round-trip wait
    // (saveDraft + reload) before the user sees the wheel screen. If the
    // write fails the next reload will reconcile.
    setBlocks(prev => [...prev, newBlock as CloudBlock]);
    navigateToBlock(newBlock as CloudBlock, false);
    saveDraft(activeUser.uid, newBlock).catch(e => console.error('saveDraft failed:', e));
  }, [user, navigateToBlock]);

  // Gating ────────────────────────────────────────────────────────────────
  // Anonymous-first: AuthContext kicks off signInAnonymously in the
  // background but does NOT block first paint on it. The shell renders
  // immediately; surfaces that need a uid (Create, Profile blocks) gracefully
  // wait for `user` to populate.
  if (authLoading) return null;
  // Fallback: anonymous provider disabled in Firebase — show Google sign-in
  // so the user can still get in.
  if (!user && anonymousAuthBlocked) return <LoginScreen onLoginSuccess={() => {}} />;
  // Profile setup is a permanent-user gate, not an anonymous-user gate.
  if (user && !isAnonymous && profileLoading) return null;
  if (user && !isAnonymous && !profile) return <ProfileSetupScreen />;

  return (
    <>
      {/* AppShell is the persistent base layer. Detail screens (block, wheel,
          play, profile, diagnostics) render as fixed-position overlays on top
          via the Routes below, so when an overlay slides out (e.g. the editor
          X) the home content underneath is already visible — no white flash. */}
      <AppShell
        blocks={blocks}
        blocksLoaded={blocksLoaded}
        onCreateBlock={() => setShowCreateSheet(true)}
        onBlockTap={block => navigateToBlock(block)}
        onBlockEdit={openForEditing}
        onBlockDuplicate={handleBlockDuplicate}
        onBlockDelete={handleBlockDelete}
        onBlockReorder={handleBlockReorder}
      />
      <Routes>
        <Route path="/" element={null} />
        <Route path="/block/:id" element={
          <RouteOverlay>
            <BlockRoute blocks={blocks} onBlockUpdated={handleBlockUpdated} onBlockDelete={handleBlockDelete} />
          </RouteOverlay>
        } />
        <Route path="/wheel/:wheelId" element={<RouteOverlay><WheelDetailScreen /></RouteOverlay>} />
        <Route path="/u/:handle" element={<RouteOverlay><UserProfileScreen /></RouteOverlay>} />
        <Route path="/e/:id/play" element={<RouteOverlay><ExperiencePlayScreen /></RouteOverlay>} />
        <Route path="/diagnostics" element={<RouteOverlay><DiagnosticsScreen /></RouteOverlay>} />
      </Routes>
      {showCreateSheet && (
        <CreateSheet
          onTypeSelected={handleCreateType}
          onClose={() => setShowCreateSheet(false)}
        />
      )}
    </>
  );
}

// Fixed-position wrapper for full-screen detail routes. Sits above the
// always-mounted AppShell so the home content is the background revealed
// during slide-out animations. NO background of its own — the child screen
// supplies its own bg, and once the child slides off the AppShell shows
// through directly.
function RouteOverlay({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      zIndex: 50,
    }}>
      {children}
    </div>
  );
}

function BlockRoute({ blocks, onBlockUpdated, onBlockDelete }: { blocks: Block[]; onBlockUpdated: (b: Block) => void; onBlockDelete: (id: string) => void }) {
  const location = useLocation();
  const state = location.state as { block: Block; editMode: boolean } | null;

  if (!state?.block) return <div>Block not found</div>;

  const { block, editMode } = state;

  switch (block.type) {
    case 'roulette':
      return <BlockScreen onBlockUpdated={onBlockUpdated} onBlockDelete={onBlockDelete} />;
    case 'listRandomizer':
      return <ListRandomizerScreen block={block} editMode={editMode} onBlockUpdated={onBlockUpdated} />;
    case 'experience':
      // Defensive fallback: every Experience tile-tap should resolve through
      // openExperienceFlow and land on a wheel-step. If we somehow get here
      // with a raw Experience block (deep link, hot-reload, stale state),
      // route to home so the user re-opens it via a tile and the unified
      // wheel-screen path. The old ExperienceBuilderScreen is no longer used.
      return <Navigate to="/" replace />;
  }
}

interface AppShellProps {
  blocks: CloudBlock[];
  blocksLoaded: boolean;
  onCreateBlock: () => void;
  onBlockTap: (block: CloudBlock) => void;
  onBlockEdit: (block: CloudBlock) => void;
  onBlockDuplicate: (block: CloudBlock) => void;
  onBlockDelete: (id: string) => void;
  onBlockReorder: (orderedIds: string[]) => void;
}

function AppShell({ blocks, blocksLoaded, onCreateBlock, onBlockTap, onBlockEdit, onBlockDuplicate, onBlockDelete, onBlockReorder }: AppShellProps) {
  // Persist the selected tab across AppShell remounts (e.g. when the user
  // navigates to /block/:id and then presses back, AppShell re-mounts at /
  // and would otherwise reset to Feed).
  const [tab, setTabState] = useState<number>(() => {
    const saved = sessionStorage.getItem('appShellTab');
    const parsed = saved !== null ? parseInt(saved, 10) : 0;
    return Number.isFinite(parsed) ? parsed : 0;
  });
  const setTab = (next: number) => {
    setTabState(next);
    sessionStorage.setItem('appShellTab', String(next));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100dvh' }}>
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {tab === 0 && <FeedScreen />}
        {tab === 1 && (
          <MyProfileScreen
            blocks={blocks}
            blocksLoaded={blocksLoaded}
            onBlockTap={onBlockTap}
            onBlockEdit={onBlockEdit}
            onBlockDuplicate={onBlockDuplicate}
            onBlockDelete={onBlockDelete}
            onBlockReorder={onBlockReorder}
          />
        )}
      </div>
      <div style={{
        display: 'flex',
        borderTop: `1px solid ${BORDER}`,
        backgroundColor: SURFACE,
        padding: '8px',
      }}>
        <NavItem icon={<Compass size={24} />} label="Feed" isSelected={tab === 0} onTap={() => setTab(0)} />
        <NavItem icon={<PlusCircle size={24} />} label="Create" isSelected={false} onTap={onCreateBlock} />
        <NavItem icon={<User size={24} />} label="Profile" isSelected={tab === 1} onTap={() => setTab(1)} />
      </div>
    </div>
  );
}

function NavItem({ icon, label, isSelected, onTap }: {
  icon: React.ReactNode;
  label: string;
  isSelected: boolean;
  onTap: () => void;
}) {
  const color = isSelected ? PRIMARY : withAlpha(ON_SURFACE, 0.4);
  return (
    <div
      onClick={onTap}
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '4px 0',
        cursor: 'pointer',
        color,
      }}
    >
      {icon}
      <span style={{ fontSize: 11, fontWeight: isSelected ? 700 : 600, marginTop: 4 }}>{label}</span>
    </div>
  );
}
