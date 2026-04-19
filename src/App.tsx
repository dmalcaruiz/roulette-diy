import { useState, useEffect, useCallback } from 'react';
import { Routes, Route, useNavigate, useLocation } from 'react-router-dom';
import { Block, BlockType, newRouletteBlock, newListRandomizerBlock, newExperienceBlock } from './models/types';
import { loadDrafts, saveDraft, deleteDraft, migrateLocalBlocksIfNeeded, type CloudBlock } from './services/blockService';
import { dbg, sid, sids } from './utils/debugLog';
import { useAuth } from './contexts/AuthContext';
import LoginScreen from './screens/LoginScreen';
import ProfileSetupScreen from './screens/ProfileSetupScreen';
import CreateSheet from './screens/CreateSheet';
import BlockScreen from './screens/BlockScreen';
import ListRandomizerScreen from './screens/ListRandomizerScreen';
import ExperienceBuilderScreen from './screens/ExperienceBuilderScreen';
import FeedScreen from './screens/FeedScreen';
import WheelDetailScreen from './screens/WheelDetailScreen';
import UserProfileScreen from './screens/UserProfileScreen';
import MyProfileScreen from './screens/MyProfileScreen';
import DiagnosticsScreen from './screens/DiagnosticsScreen';
import { withAlpha } from './utils/colorUtils';
import { ON_SURFACE, PRIMARY, BORDER } from './utils/constants';
import { PlusCircle, Compass, User } from 'lucide-react';

export default function App() {
  const { user, profile, authLoading, profileLoading } = useAuth();
  const [blocks, setBlocks] = useState<CloudBlock[]>([]);
  const [showCreateSheet, setShowCreateSheet] = useState(false);
  const navigate = useNavigate();

  const reload = useCallback(async () => {
    if (!user) return;
    try {
      const drafts = await loadDrafts(user.uid);
      setBlocks(drafts);
    } catch (e) {
      console.error('Failed to load drafts:', e);
    }
  }, [user]);

  // Run migration + initial load once we have an authenticated user + profile.
  useEffect(() => {
    if (!user || !profile) return;
    (async () => {
      try {
        const { migrated } = await migrateLocalBlocksIfNeeded(user.uid);
        if (migrated > 0) console.log(`Migrated ${migrated} blocks from localStorage.`);
        await reload();
      } catch (e) {
        console.error('Migration/reload failed:', e);
      }
    })();
  }, [user, profile, reload]);

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

  const handleBlockDelete = useCallback(async (id: string) => {
    if (!user) return;
    await deleteDraft(user.uid, id);
    reload();
  }, [user, reload]);

  const navigateToBlock = useCallback((block: Block, editMode = false) => {
    navigate(`/block/${block.id}`, { state: { block, editMode } });
  }, [navigate]);

  // Open a block for editing. If it's part of a flow, resolve the parent
  // Experience + all step blocks locally (we already have them in `blocks`)
  // and pass them through navigation state — BlockScreen has the full flow
  // on first render, no Firestore fetch delay before the preview row fills.
  const openForEditing = useCallback((block: CloudBlock) => {
    const parentId = block.parentExperienceId;
    dbg('App.openForEditing', 'enter', { block: sid(block.id), parent: sid(parentId ?? null) });
    if (parentId) {
      const experience = blocks.find(b => b.id === parentId);
      const steps = experience?.experienceConfig?.steps;
      if (experience && steps && steps.length > 0) {
        const stepBlocks = steps
          .map(s => blocks.find(b => b.id === s.blockId))
          .filter((b): b is CloudBlock => !!b);
        if (stepBlocks.length > 0) {
          dbg('App.openForEditing', 'resolved-flow', {
            exp: sid(experience.id),
            step0: sid(stepBlocks[0].id),
            steps: sids(stepBlocks),
          });
          navigate(`/block/${stepBlocks[0].id}`, {
            state: {
              block: stepBlocks[0],
              editMode: true,
              flowExperience: experience,
              flowSteps: stepBlocks,
            },
          });
          return;
        }
      }
      dbg('App.openForEditing', 'flow-unresolved-fallback', { block: sid(block.id) });
    }
    dbg('App.openForEditing', 'standalone-navigate', { block: sid(block.id) });
    navigateToBlock(block, true);
  }, [blocks, navigate, navigateToBlock]);

  const handleCreateType = useCallback(async (type: BlockType) => {
    if (!user) return;
    setShowCreateSheet(false);
    let newBlock: Block;
    switch (type) {
      case 'roulette': newBlock = newRouletteBlock(); break;
      case 'listRandomizer': newBlock = newListRandomizerBlock(); break;
      case 'experience': newBlock = newExperienceBlock(); break;
    }
    await saveDraft(user.uid, newBlock);
    await reload();
    // Land on the publish/preview screen — user taps "Edit wheel" to open
    // the editor overlay. Keeps Create consistent with tile-tap flow.
    navigateToBlock(newBlock, false);
  }, [user, reload, navigateToBlock]);

  // Gating ────────────────────────────────────────────────────────────────
  if (authLoading) return null;
  if (!user) return <LoginScreen onLoginSuccess={() => {}} />;
  if (profileLoading) return null;
  if (!profile) return <ProfileSetupScreen />;

  return (
    <>
      <Routes>
        <Route path="/" element={
          <AppShell
            blocks={blocks}
            onCreateBlock={() => setShowCreateSheet(true)}
            onBlockTap={block => navigateToBlock(block)}
            onBlockEdit={openForEditing}
            onBlockDuplicate={handleBlockDuplicate}
            onBlockDelete={handleBlockDelete}
          />
        } />
        <Route path="/block/:id" element={
          <BlockRoute blocks={blocks} onBlockUpdated={handleBlockUpdated} />
        } />
        <Route path="/wheel/:wheelId" element={<WheelDetailScreen />} />
        <Route path="/u/:handle" element={<UserProfileScreen />} />
        <Route path="/diagnostics" element={<DiagnosticsScreen />} />
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

function BlockRoute({ blocks, onBlockUpdated }: { blocks: Block[]; onBlockUpdated: (b: Block) => void }) {
  const location = useLocation();
  const state = location.state as { block: Block; editMode: boolean } | null;

  if (!state?.block) return <div>Block not found</div>;

  const { block, editMode } = state;

  switch (block.type) {
    case 'roulette':
      return <BlockScreen onBlockUpdated={onBlockUpdated} />;
    case 'listRandomizer':
      return <ListRandomizerScreen block={block} editMode={editMode} onBlockUpdated={onBlockUpdated} />;
    case 'experience':
      return <ExperienceBuilderScreen block={block} allBlocks={blocks} onBlockUpdated={onBlockUpdated} />;
  }
}

interface AppShellProps {
  blocks: CloudBlock[];
  onCreateBlock: () => void;
  onBlockTap: (block: CloudBlock) => void;
  onBlockEdit: (block: CloudBlock) => void;
  onBlockDuplicate: (block: CloudBlock) => void;
  onBlockDelete: (id: string) => void;
}

function AppShell({ blocks, onCreateBlock, onBlockTap, onBlockEdit, onBlockDuplicate, onBlockDelete }: AppShellProps) {
  const [tab, setTab] = useState(0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100dvh' }}>
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {tab === 0 && <FeedScreen />}
        {tab === 1 && (
          <MyProfileScreen
            blocks={blocks}
            onBlockTap={onBlockTap}
            onBlockEdit={onBlockEdit}
            onBlockDuplicate={onBlockDuplicate}
            onBlockDelete={onBlockDelete}
          />
        )}
      </div>
      <div style={{
        display: 'flex',
        borderTop: `1px solid ${BORDER}`,
        backgroundColor: '#FFFFFF',
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
