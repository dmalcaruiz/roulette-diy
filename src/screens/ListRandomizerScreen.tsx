import { useState, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Block, ListCategory } from '../models/types';
import { PushDownButton, InsetTextField } from '../components/PushDownButton';
import SwipeableActionCell from '../components/SwipeableActionCell';
import { oklchShadow, withAlpha } from '../utils/colorUtils';
import { ON_SURFACE, BORDER, PRIMARY, SEGMENT_COLORS, BG, SURFACE, SURFACE_ELEVATED } from '../utils/constants';
import {
  ArrowLeft, Eye, Pencil, MoreVertical, RotateCcw, Dices,
  GripVertical, ChevronDown, Plus, X, Copy, Trash2,
} from 'lucide-react';

function colorForIndex(i: number) { return SEGMENT_COLORS[i % SEGMENT_COLORS.length]; }

interface ListRandomizerScreenProps {
  block: Block;
  editMode?: boolean;
  onBlockUpdated?: (block: Block) => void;
}

export default function ListRandomizerScreen({ block, editMode = false, onBlockUpdated }: ListRandomizerScreenProps) {
  const navigate = useNavigate();
  const [currentBlock, setCurrentBlock] = useState(block);
  const [isEditMode, setIsEditMode] = useState(editMode);
  const [results, setResults] = useState<(string | null)[]>(
    () => new Array(block.listConfig?.categories.length ?? 0).fill(null)
  );
  const [isShuffling, setIsShuffling] = useState<boolean[]>(
    () => new Array(block.listConfig?.categories.length ?? 0).fill(false)
  );
  const [expandedCat, setExpandedCat] = useState<number | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const categories = currentBlock.listConfig?.categories ?? [];

  const autoSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      onBlockUpdated?.(currentBlock);
    }, 400);
  }, [currentBlock, onBlockUpdated]);

  const randomizeCategory = async (index: number) => {
    const options = categories[index]?.options;
    if (!options?.length || isShuffling[index]) return;

    setIsShuffling(s => { const n = [...s]; n[index] = true; return n; });

    const duration = 500;
    const start = Date.now();
    while (Date.now() - start < duration) {
      setResults(r => { const n = [...r]; n[index] = options[Math.floor(Math.random() * options.length)]; return n; });
      await new Promise(r => setTimeout(r, 50));
    }
    setResults(r => { const n = [...r]; n[index] = options[Math.floor(Math.random() * options.length)]; return n; });
    setIsShuffling(s => { const n = [...s]; n[index] = false; return n; });
  };

  const randomizeAll = () => {
    categories.forEach((_, i) => setTimeout(() => randomizeCategory(i), i * 120));
  };

  const updateCategory = (index: number, updates: Partial<ListCategory>) => {
    const newBlock = { ...currentBlock };
    const cats = [...(newBlock.listConfig?.categories ?? [])];
    cats[index] = { ...cats[index], ...updates };
    newBlock.listConfig = { categories: cats };
    setCurrentBlock(newBlock);
    autoSave();
  };

  const addCategory = () => {
    const newBlock = { ...currentBlock };
    const cats = [...(newBlock.listConfig?.categories ?? [])];
    cats.push({ name: `Category ${cats.length + 1}`, options: ['Option 1'] });
    newBlock.listConfig = { categories: cats };
    setCurrentBlock(newBlock);
    setResults(r => [...r, null]);
    setIsShuffling(s => [...s, false]);
    autoSave();
  };

  const removeCategory = (index: number) => {
    if (categories.length <= 1) return;
    const newBlock = { ...currentBlock };
    const cats = [...(newBlock.listConfig?.categories ?? [])];
    cats.splice(index, 1);
    newBlock.listConfig = { categories: cats };
    setCurrentBlock(newBlock);
    setResults(r => r.filter((_, i) => i !== index));
    setIsShuffling(s => s.filter((_, i) => i !== index));
    setExpandedCat(null);
    autoSave();
  };

  const duplicateCategory = (index: number) => {
    const original = categories[index];
    const copy = { name: `${original.name} (Copy)`, options: [...original.options] };
    const newBlock = { ...currentBlock };
    const cats = [...(newBlock.listConfig?.categories ?? [])];
    cats.splice(index + 1, 0, copy);
    newBlock.listConfig = { categories: cats };
    setCurrentBlock(newBlock);
    setResults(r => { const n = [...r]; n.splice(index + 1, 0, null); return n; });
    setIsShuffling(s => { const n = [...s]; n.splice(index + 1, 0, false); return n; });
    autoSave();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100dvh', backgroundColor: BG }}>
      {/* App bar */}
      <div style={{ display: 'flex', alignItems: 'center', padding: '8px 8px 0' }}>
        <button onClick={() => navigate('/')} style={{ padding: 8 }}>
          <ArrowLeft size={24} color={ON_SURFACE} />
        </button>
        <div style={{ width: 4 }} />
        {isEditMode ? (
          <>
            <span style={{ flex: 1, fontSize: 22, fontWeight: 700, color: ON_SURFACE }}>Edit List</span>
            <button onClick={() => setIsEditMode(false)} style={{ padding: 8 }}>
              <Eye size={22} color={ON_SURFACE} />
            </button>
          </>
        ) : (
          <>
            <span style={{
              flex: 1,
              fontSize: 20,
              fontWeight: 700,
              color: ON_SURFACE,
              textAlign: 'center',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              {currentBlock.name}
            </span>
            <button onClick={() => setIsEditMode(true)} style={{ padding: 8 }}>
              <Pencil size={22} color={ON_SURFACE} />
            </button>
          </>
        )}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        {isEditMode ? (
          <div style={{ padding: '12px 20px 16px' }}>
            <InsetTextField
              value={currentBlock.name}
              onChange={v => { setCurrentBlock({ ...currentBlock, name: v }); autoSave(); }}
              placeholder="List name"
              inputStyle={{ fontWeight: 700, fontSize: 18 }}
            />
            <div style={{ height: 18 }} />
            {categories.map((cat, i) => {
              const isExpanded = expandedCat === i;
              const color = colorForIndex(i);

              return (
                <div key={i} style={{ marginBottom: 8 }}>
                  <SwipeableActionCell
                    trailingActions={[
                      { color: PRIMARY, icon: <Copy size={20} />, onTap: () => duplicateCategory(i) },
                      { color: '#EF4444', icon: <Trash2 size={20} />, onTap: () => removeCategory(i), expandOnFullSwipe: true },
                    ]}
                  >
                    <CategoryCard3D color={isExpanded ? SURFACE : color} expandedBorderColor={isExpanded ? color : undefined}>
                      {/* Collapsed header */}
                      <div
                        onClick={() => setExpandedCat(isExpanded ? null : i)}
                        style={{ display: 'flex', alignItems: 'center', padding: '8px 0', cursor: 'pointer' }}
                      >
                        <div style={{ padding: '0 14px' }}>
                          <GripVertical size={22} color={isExpanded ? withAlpha(ON_SURFACE, 0.3) : 'rgba(255,255,255,0.6)'} />
                        </div>
                        <div style={{ flex: 1 }}>
                          {isExpanded ? (
                            <InsetTextField
                              value={cat.name}
                              onChange={v => updateCategory(i, { name: v })}
                              placeholder="Category name"
                              inputStyle={{ fontWeight: 600, fontSize: 16 }}
                            />
                          ) : (
                            <div style={{ padding: '10px 12px', fontWeight: 600, fontSize: 16, color: '#FFF', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {cat.name}
                            </div>
                          )}
                        </div>
                        <div style={{ padding: '0 14px', transform: `rotate(${isExpanded ? 180 : 0}deg)`, transition: 'transform 0.2s' }}>
                          <ChevronDown size={26} color={isExpanded ? withAlpha(ON_SURFACE, 0.35) : 'rgba(255,255,255,0.6)'} />
                        </div>
                      </div>

                      {/* Expanded content */}
                      {isExpanded && (
                        <div onClick={e => e.stopPropagation()} style={{ padding: '0 14px 14px' }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: withAlpha(ON_SURFACE, 0.5), marginBottom: 8 }}>Options</div>
                          {cat.options.map((opt, optIdx) => (
                            <div key={optIdx} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                              <input
                                type="text"
                                value={opt}
                                onChange={e => {
                                  const newOpts = [...cat.options];
                                  newOpts[optIdx] = e.target.value;
                                  updateCategory(i, { options: newOpts });
                                }}
                                style={{
                                  flex: 1, padding: '10px 12px', borderRadius: 12,
                                  border: `1.5px solid ${BORDER}`, backgroundColor: SURFACE_ELEVATED,
                                  fontWeight: 600, fontSize: 14, fontFamily: 'inherit', outline: 'none',
                                }}
                              />
                              <div
                                onClick={() => {
                                  if (cat.options.length <= 1) return;
                                  const newOpts = cat.options.filter((_, j) => j !== optIdx);
                                  updateCategory(i, { options: newOpts });
                                }}
                                style={{
                                  width: 32, height: 32, borderRadius: 8,
                                  backgroundColor: '#FEE2E2',
                                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                                  cursor: 'pointer', alignSelf: 'center',
                                }}
                              >
                                <X size={16} color="#EF4444" />
                              </div>
                            </div>
                          ))}
                          <div style={{ marginTop: 6 }}>
                            <div
                              onClick={() => updateCategory(i, { options: [...cat.options, `Option ${cat.options.length + 1}`] })}
                              style={{
                                height: 40, borderRadius: 12,
                                backgroundColor: SURFACE_ELEVATED, border: `1.5px solid ${BORDER}`,
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                gap: 6, cursor: 'pointer',
                                fontSize: 13, fontWeight: 700, color: withAlpha(ON_SURFACE, 0.5),
                              }}
                            >
                              <Plus size={18} /> Add Option
                            </div>
                          </div>
                        </div>
                      )}
                    </CategoryCard3D>
                  </SwipeableActionCell>
                </div>
              );
            })}
            <div style={{ height: 12 }} />
            <PushDownButton color={ON_SURFACE} onTap={addCategory}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, color: '#FFF' }}>
                <Plus size={22} /> <span style={{ fontWeight: 700, fontSize: 15 }}>Add Category</span>
              </div>
            </PushDownButton>
          </div>
        ) : (
          <div style={{ padding: '16px 20px' }}>
            {categories.map((cat, i) => (
              <div key={i} style={{ marginBottom: 10 }}>
                <PlayCategoryCard
                  category={cat}
                  color={colorForIndex(i)}
                  result={results[i]}
                  isShuffling={isShuffling[i]}
                  onTap={() => randomizeCategory(i)}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Bottom button (play mode) */}
      {!isEditMode && (
        <div style={{ padding: '8px 20px 16px' }}>
          <PushDownButton color={PRIMARY} onTap={randomizeAll}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, color: '#FFF' }}>
              <Dices size={22} />
              <span style={{ fontSize: 17, fontWeight: 800, letterSpacing: 0.5 }}>Randomize All</span>
            </div>
          </PushDownButton>
        </div>
      )}
    </div>
  );
}

function PlayCategoryCard({ category, color, result, isShuffling, onTap }: {
  category: ListCategory;
  color: string;
  result: string | null;
  isShuffling: boolean;
  onTap: () => void;
}) {
  const bottomColor = oklchShadow(color);
  const innerStroke = oklchShadow(color, 0.06);

  return (
    <div onClick={onTap} style={{ position: 'relative', cursor: 'pointer' }}>
      <div style={{
        position: 'absolute', left: 0, right: 0, top: 6.5, bottom: 0,
        borderRadius: 21, backgroundColor: bottomColor,
        border: `2.5px solid ${oklchShadow(color, 0.16)}`,
      }} />
      <div style={{
        position: 'relative', marginBottom: 6.5, borderRadius: 21,
        backgroundColor: color, border: `2.5px solid ${innerStroke}`,
        padding: '18px 22px',
      }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'rgba(255,255,255,0.7)' }}>{category.name}</div>
        <div style={{ marginTop: 6, fontSize: result ? 24 : 20, fontWeight: 800, color: result ? '#FFF' : 'rgba(255,255,255,0.5)' }}>
          {result ?? 'Tap to roll'}
        </div>
      </div>
    </div>
  );
}

function CategoryCard3D({ color, expandedBorderColor, children }: {
  color: string;
  expandedBorderColor?: string;
  children: React.ReactNode;
}) {
  const shadowSource = expandedBorderColor ?? color;
  const bottomColor = oklchShadow(shadowSource);
  const innerStroke = oklchShadow(color, 0.06);
  const isExpanded = !!expandedBorderColor;

  return (
    <div style={{ position: 'relative' }}>
      <div style={{
        position: 'absolute', left: 0, right: 0, top: 6.5, bottom: 0,
        borderRadius: 21, backgroundColor: bottomColor,
        border: `2.5px solid ${oklchShadow(shadowSource, 0.16)}`,
        transition: 'all 0.2s',
      }} />
      <div style={{
        position: 'relative', marginBottom: 6.5, borderRadius: 21,
        backgroundColor: color,
        border: `${isExpanded ? 3 : 2.5}px solid ${isExpanded ? expandedBorderColor : innerStroke}`,
        overflow: 'hidden',
        transition: 'all 0.2s',
      }}>
        {children}
      </div>
    </div>
  );
}
