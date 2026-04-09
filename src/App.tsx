import { useState, useEffect, useCallback } from 'react';
import { Routes, Route, useNavigate, useLocation } from 'react-router-dom';
import { onAuthStateChanged, User } from 'firebase/auth';
import { auth } from './firebase';
import { Block, BlockType, newRouletteBlock, newListRandomizerBlock, newExperienceBlock } from './models/types';
import { loadBlocks, saveBlock, deleteBlock, saveOrder } from './models/blockManager';
import LoginScreen from './screens/LoginScreen';
import HomeScreen from './screens/HomeScreen';
import MyBlocksScreen from './screens/MyBlocksScreen';
import CreateSheet from './screens/CreateSheet';
import RouletteScreen from './screens/RouletteScreen';
import ListRandomizerScreen from './screens/ListRandomizerScreen';
import ExperienceBuilderScreen from './screens/ExperienceBuilderScreen';
import { withAlpha } from './utils/colorUtils';
import { ON_SURFACE, PRIMARY, BORDER } from './utils/constants';
import { Home, PlusCircle, LayoutGrid } from 'lucide-react';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [showCreateSheet, setShowCreateSheet] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setAuthLoading(false);
    });
    return unsub;
  }, []);

  const reload = useCallback(() => {
    setBlocks(loadBlocks());
  }, []);

  useEffect(() => { if (user) reload(); }, [user, reload]);

  const handleBlockUpdated = useCallback((updated: Block) => {
    saveBlock(updated);
    reload();
  }, [reload]);

  const handleBlockDuplicate = useCallback((block: Block) => {
    const duplicate: Block = {
      ...block,
      id: Date.now().toString(),
      name: `${block.name} (Copy)`,
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    };
    saveBlock(duplicate);
    reload();
  }, [reload]);

  const handleBlockDelete = useCallback((id: string) => {
    deleteBlock(id);
    reload();
  }, [reload]);

  const navigateToBlock = useCallback((block: Block, editMode = false) => {
    navigate(`/block/${block.id}`, { state: { block, editMode } });
  }, [navigate]);

  const handleCreateType = useCallback((type: BlockType) => {
    setShowCreateSheet(false);
    let newBlock: Block;
    switch (type) {
      case 'roulette': newBlock = newRouletteBlock(); break;
      case 'listRandomizer': newBlock = newListRandomizerBlock(); break;
      case 'experience': newBlock = newExperienceBlock(); break;
    }
    saveBlock(newBlock);
    reload();
    navigateToBlock(newBlock, true);
  }, [reload, navigateToBlock]);

  if (authLoading) return null;
  if (!user) return <LoginScreen onLoginSuccess={() => {}} />;

  return (
    <>
      <Routes>
        <Route path="/" element={
          <AppShell
            blocks={blocks}
            onCreateBlock={() => setShowCreateSheet(true)}
            onBlockTap={block => navigateToBlock(block)}
            onBlockEdit={block => navigateToBlock(block, true)}
            onBlockDuplicate={handleBlockDuplicate}
            onBlockDelete={handleBlockDelete}
          />
        } />
        <Route path="/block/:id" element={
          <BlockRoute
            blocks={blocks}
            onBlockUpdated={handleBlockUpdated}
          />
        } />
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
      return <RouletteScreen block={block} editMode={editMode} onBlockUpdated={onBlockUpdated} />;
    case 'listRandomizer':
      return <ListRandomizerScreen block={block} editMode={editMode} onBlockUpdated={onBlockUpdated} />;
    case 'experience':
      return <ExperienceBuilderScreen block={block} allBlocks={blocks} onBlockUpdated={onBlockUpdated} />;
  }
}

interface AppShellProps {
  blocks: Block[];
  onCreateBlock: () => void;
  onBlockTap: (block: Block) => void;
  onBlockEdit: (block: Block) => void;
  onBlockDuplicate: (block: Block) => void;
  onBlockDelete: (id: string) => void;
}

function AppShell({ blocks, onCreateBlock, onBlockTap, onBlockEdit, onBlockDuplicate, onBlockDelete }: AppShellProps) {
  const [tab, setTab] = useState(0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100dvh' }}>
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {tab === 0 ? (
          <HomeScreen blocks={blocks} onCreateBlock={onCreateBlock} onBlockTap={onBlockTap} />
        ) : (
          <MyBlocksScreen
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
        <NavItem icon={<Home size={24} />} label="Home" isSelected={tab === 0} onTap={() => setTab(0)} />
        <NavItem icon={<PlusCircle size={24} />} label="Create" isSelected={false} onTap={onCreateBlock} />
        <NavItem icon={<LayoutGrid size={24} />} label="My Blocks" isSelected={tab === 1} onTap={() => setTab(1)} />
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
